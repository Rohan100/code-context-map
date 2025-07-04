import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GraphData, GraphNode, GraphEdge } from './types';

export class CodeAnalyzer {
    private program?: ts.Program;
    private checker?: ts.TypeChecker;
    private astCache = new Map<string, ts.SourceFile>();
    private processedFiles = new Set<string>();
    private importGraph = new Map<string, Set<string>>();

    public async analyzeActiveFile(activeFilePath: string, workspacePath?: string): Promise<GraphData> {
        // Reset state for new analysis
        this.processedFiles.clear();
        this.importGraph.clear();

        // Get all related files starting from active file
        const relatedFiles = await this.getAllRelatedFiles(activeFilePath, workspacePath);


        // Create TypeScript program with all related files
        const compilerOptions: ts.CompilerOptions = {
            target: ts.ScriptTarget.ES2020,
            module: ts.ModuleKind.CommonJS,
            allowJs: true,
            checkJs: false,
            declaration: false,
            outDir: './out',
            strict: false,
            esModuleInterop: true,
            skipLibCheck: true,
            forceConsistentCasingInFileNames: true
        };

        this.program = ts.createProgram(Array.from(relatedFiles), compilerOptions);
        this.checker = this.program.getTypeChecker();

        // Analyze the active file and build call graph
        return this.buildCallGraphFromActiveFile(activeFilePath);
    }

    private async getAllRelatedFiles(activeFilePath: string, workspacePath?: string): Promise<Set<string>> {
        const relatedFiles = new Set<string>();
        const filesToProcess = new Set<string>([activeFilePath]);
        const processed = new Set<string>();

        // Get workspace files for context if available
        let workspaceFiles: Set<string> = new Set();
        if (workspacePath) {
            try {
                const allFiles = await this.getTypeScriptFiles(workspacePath);
                workspaceFiles = new Set(allFiles);
            } catch (error) {
                console.warn('Error getting workspace files:', error);
            }
        }

        while (filesToProcess.size > 0) {
            const currentFile = filesToProcess.values().next().value;
            if (typeof currentFile !== 'string') {
                continue;
            }
            filesToProcess.delete(currentFile);

            if (processed.has(currentFile)) {
                continue;
            }

            processed.add(currentFile);
            relatedFiles.add(currentFile);

            // Get imports from current file
            const imports = await this.getImportsFromFilePath(currentFile);

            for (const importInfo of imports) {
                const resolvedPath = this.resolveImportPath(importInfo.modulePath, currentFile);

                if (resolvedPath && !processed.has(resolvedPath)) {
                    // Only include files that are in workspace or are direct dependencies
                    if (!workspacePath || workspaceFiles.has(resolvedPath) || this.isDirectDependency(resolvedPath, workspacePath)) {
                        filesToProcess.add(resolvedPath);

                        // Build import graph for better resolution
                        if (!this.importGraph.has(currentFile)) {
                            this.importGraph.set(currentFile, new Set());
                        }
                        this.importGraph.get(currentFile)!.add(resolvedPath);
                    }
                }
            }
        }

        return relatedFiles;
    }

    private isDirectDependency(filePath: string, workspacePath?: string): boolean {
        if (!workspacePath) return true;

        // Check if the file is within reasonable distance from workspace
        const relativePath = path.relative(workspacePath, filePath);
        const pathParts = relativePath.split(path.sep);

        // Allow files that are not too deep in node_modules or are local files
        return !relativePath.startsWith('..') ||
            (pathParts.includes('node_modules') && pathParts.length <= 4) ||
            relativePath.length < 200; // Reasonable path length limit
    }

    private async getImportsFromFilePath(filePath: string): Promise<Array<{ modulePath: string, importedNames: string[] }>> {
        if (!fs.existsSync(filePath)) {
            return [];
        }

        try {
            const content = fs.readFileSync(filePath, 'utf-8');
            const sourceFile = ts.createSourceFile(
                filePath,
                content,
                ts.ScriptTarget.ES2020,
                true
            );

            return this.getImportsFromFile(sourceFile);
        } catch (error) {
            console.warn(`Error reading file ${filePath}:`, error);
            return [];
        }
    }

    private buildCallGraphFromActiveFile(activeFilePath: string): GraphData {
        const nodes: GraphNode[] = [];
        const edges: GraphEdge[] = [];
        const visitedFunctions = new Set<string>();
        const functionCallMap = new Map<string, Set<string>>();

        // First pass: collect all functions and their calls across all related files
        this.collectAllFunctions(functionCallMap);
        console.log("functionCallMap", functionCallMap);
        // Start with the active file
        const activeSourceFile = this.program!.getSourceFile(activeFilePath);
        if (!activeSourceFile) {
            return { nodes, edges };
        }

        // Add active file node
        const activeFileNode: GraphNode = {
            id: `file:${activeFilePath}`,
            name: path.basename(activeFilePath),
            type: 'file',
            filePath: activeFilePath,
            isActiveFile: true
        };
        nodes.push(activeFileNode);

        // Find all functions in the active file
        const activeFunctions = this.extractFunctionsFromFile(activeSourceFile);

        // Add function nodes for active file
        activeFunctions.forEach(func => {
            nodes.push(func);
            edges.push({
                source: activeFileNode.id,
                target: func.id,
                type: 'contains'
            });
        });


        // Build call graph starting from active file functions
        activeFunctions.forEach(func => {
            this.buildCallChain(func.id, functionCallMap, nodes, edges, visitedFunctions);
        });

        return { nodes, edges };
    }

    private collectAllFunctions(functionCallMap: Map<string, Set<string>>) {
        // dont tract node modules files

        for (const sourceFile of this.program!.getSourceFiles()) {
            if (sourceFile.isDeclarationFile || sourceFile.fileName.includes('node_modules')) continue;
            this.analyzeFileForCalls(sourceFile, functionCallMap);
        }
    }

    private analyzeFileForCalls(sourceFile: ts.SourceFile, functionCallMap: Map<string, Set<string>>) {
        const filePath = sourceFile.fileName;

        const visit = (node: ts.Node) => {
            // Handle function declarations
            if (ts.isFunctionDeclaration(node) && node.name) {
                const functionId = `function:${filePath}:${node.name.text}`;
                if (!functionCallMap.has(functionId)) {
                    functionCallMap.set(functionId, new Set());
                }

                // Find calls within this function
                this.findCallsInNode(node, sourceFile, functionCallMap.get(functionId)!, filePath);
            }

            // Handle arrow functions assigned to variables
            if (ts.isVariableDeclaration(node) && node.initializer &&
                (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
                ts.isIdentifier(node.name)) {
                const functionId = `function:${filePath}:${node.name.text}`;
                if (!functionCallMap.has(functionId)) {
                    functionCallMap.set(functionId, new Set());
                }

                this.findCallsInNode(node.initializer, sourceFile, functionCallMap.get(functionId)!, filePath);
            }

            // Handle class methods
            if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name)) {
                const classDeclaration = node.parent;
                if (ts.isClassDeclaration(classDeclaration) && classDeclaration.name) {
                    const methodId = `method:${filePath}:${classDeclaration.name.text}:${node.name.text}`;
                    if (!functionCallMap.has(methodId)) {
                        functionCallMap.set(methodId, new Set());
                    }

                    // Find calls within this method
                    this.findCallsInNode(node, sourceFile, functionCallMap.get(methodId)!, filePath);
                }
            }

            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
    }

    private findCallsInNode(node: ts.Node, sourceFile: ts.SourceFile, callSet: Set<string>, currentFilePath: string) {
        const visit = (child: ts.Node) => {
            if (ts.isCallExpression(child)) {
                const callTarget = this.resolveCallTarget(child, sourceFile, currentFilePath);
                if (callTarget) {
                    callSet.add(callTarget);
                }
            }
            ts.forEachChild(child, visit);
        };

        ts.forEachChild(node, visit);
    }

    private resolveCallTarget(callExpression: ts.CallExpression, sourceFile: ts.SourceFile, currentFilePath: string): string | null {
        if (ts.isIdentifier(callExpression.expression)) {
            // Simple function call
            const functionName = callExpression.expression.text;

            // Try to resolve in current file first
            let targetId = `function:${currentFilePath}:${functionName}`;
            if (this.functionExistsInProgram(targetId)) {
                return targetId;
            }

            // Try to resolve in imported files using enhanced resolution
            const importedTarget = this.resolveImportedFunctionEnhanced(functionName, sourceFile, currentFilePath);
            console.log("impoted Target", importedTarget)
            // debugger
            if (importedTarget) {
                return importedTarget;
            }

            // If not found and it's a known function from our program, don't mark as unknown
            const allProgramFunctions = this.findFunctionInAllFiles(functionName);
            if (allProgramFunctions.length > 0) {
                return allProgramFunctions[0]; // Return first match
            }

            // Only mark as unknown if we really can't find it
            return `function:unknown:${functionName}`;
        }

        if (ts.isPropertyAccessExpression(callExpression.expression)) {
            // Method call like obj.method()
            if (ts.isIdentifier(callExpression.expression.name)) {
                const methodName = callExpression.expression.name.text;

                // Enhanced method resolution
                const methodTarget = this.resolveMethodCallEnhanced(callExpression, sourceFile, currentFilePath);
                if (methodTarget) {
                    return methodTarget;
                }

                // Try to resolve the object type and method
                const objectType = this.resolveObjectType(callExpression.expression.expression, sourceFile);
                if (objectType) {
                    return `method:${objectType.filePath}:${objectType.className}:${methodName}`;
                }
            }
        }

        return null;
    }

    private resolveImportedFunctionEnhanced(functionName: string, sourceFile: ts.SourceFile, currentFilePath: string): string | null {
        // Find import statements and resolve function location
        const imports = this.getImportsFromFile(sourceFile);
        console.log("imports :->", imports)
        console.log("current file for imports :->", currentFilePath)
        // debugger
        for (const importInfo of imports) {
            if (importInfo.importedNames.includes(functionName)) {
                const targetFile = this.resolveImportPath(importInfo.modulePath, currentFilePath);
                if (targetFile) {
                    // Check if function exists in target file
                    const functionId = `function:${targetFile}:${functionName}`;
                    if (this.functionExistsInProgram(functionId)) {
                        return functionId;
                    }

                    // Check for arrow function or variable declaration
                    const arrowFunctionId = this.findArrowFunctionInFile(targetFile, functionName);
                    if (arrowFunctionId) {
                        return arrowFunctionId;
                    }
                }
            }
        }

        return null;
    }

    private resolveMethodCallEnhanced(callExpression: ts.CallExpression, sourceFile: ts.SourceFile, currentFilePath: string): string | null {
        if (!ts.isPropertyAccessExpression(callExpression.expression) ||
            !ts.isIdentifier(callExpression.expression.name)) {
            return null;
        }

        const methodName = callExpression.expression.name.text;
        const objectExpression = callExpression.expression.expression;

        // Try to use TypeChecker for better resolution
        if (this.checker) {
            try {
                const type = this.checker.getTypeAtLocation(objectExpression);
                const symbol = type.getSymbol();

                if (symbol && symbol.declarations) {
                    for (const declaration of symbol.declarations) {
                        const sourceFile = declaration.getSourceFile();
                        if (ts.isClassDeclaration(declaration) && declaration.name) {
                            const methodId = `method:${sourceFile.fileName}:${declaration.name.text}:${methodName}`;
                            if (this.functionExistsInProgram(methodId)) {
                                return methodId;
                            }
                        }
                    }
                }
            } catch (error) {
                // TypeChecker failed, continue with fallback
            }
        }

        return null;
    }

    private findFunctionInAllFiles(functionName: string): string[] {
        const matches: string[] = [];

        for (const sourceFile of this.program!.getSourceFiles()) {
            if (sourceFile.isDeclarationFile) continue;

            const filePath = sourceFile.fileName;
            const functionId = `function:${filePath}:${functionName}`;

            if (this.functionExistsInFile(sourceFile, functionName)) {
                matches.push(functionId);
            }
        }

        return matches;
    }

    private findArrowFunctionInFile(filePath: string, functionName: string): string | null {
        const sourceFile = this.program!.getSourceFile(filePath);
        if (!sourceFile) return null;

        let found: string | null = null;

        const visit = (node: ts.Node) => {
            if (ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === functionName &&
                node.initializer &&
                (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
                found = `function:${filePath}:${functionName}`;
                return;
            }

            if (!found) {
                ts.forEachChild(node, visit);
            }
        };

        visit(sourceFile);
        return found;
    }

    private functionExistsInProgram(functionId: string): boolean {
        // Match: type:path:functionName
        const firstColon = functionId.indexOf(':');
        const lastColon = functionId.lastIndexOf(':');

        if (firstColon === -1 || lastColon === -1 || firstColon === lastColon) {
            return false; // invalid format
        }

        const type = functionId.substring(0, firstColon);
        const filePath = functionId.substring(firstColon + 1, lastColon);
        const name = functionId.substring(lastColon + 1);
        console.log(type, filePath, name)
        const sourceFile = this.program!.getSourceFile(filePath);
        if (!sourceFile) return false;

        if (type === 'function') {
            // debugger
            const res = this.functionExistsInFile(sourceFile, name);
            return res
        } else if (type === 'method') {
            const [className, methodName] = name.split('.');
            return this.methodExistsInFile(sourceFile, className, methodName);
        }

        return false;
    }


    private functionExistsInFile(sourceFile: ts.SourceFile, functionName: string): boolean {
        let found = false;

        const visit = (node: ts.Node) => {
            if (found) return; // Optimization: stop traversal early

            // Named function declarations
            if (ts.isFunctionDeclaration(node) && node.name?.text === functionName) {
                found = true;
                return;
            }

            // Arrow functions or function expressions assigned to variables
            if (
                ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === functionName &&
                node.initializer &&
                (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))
            ) {
                found = true;
                return;
            }

            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return found;
    }


    private methodExistsInFile(sourceFile: ts.SourceFile, className: string, methodName: string): boolean {
        let found = false;

        const visit = (node: ts.Node) => {
            if (ts.isClassDeclaration(node) && node.name && node.name.text === className) {
                for (const member of node.members) {
                    if (ts.isMethodDeclaration(member) &&
                        ts.isIdentifier(member.name) &&
                        member.name.text === methodName) {
                        found = true;
                        return;
                    }
                }
            }

            if (!found) {
                ts.forEachChild(node, visit);
            }
        };

        visit(sourceFile);
        return found;
    }

    private functionExists(functionId: string): boolean {
        return this.functionExistsInProgram(functionId);
    }

    private resolveImportedFunction(functionName: string, sourceFile: ts.SourceFile): string | null {
        return this.resolveImportedFunctionEnhanced(functionName, sourceFile, sourceFile.fileName);
    }

    private getImportsFromFile(sourceFile: ts.SourceFile): Array<{ modulePath: string, importedNames: string[] }> {
        const imports: Array<{ modulePath: string, importedNames: string[] }> = [];

        const visit = (node: ts.Node) => {
            if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
                const modulePath = node.moduleSpecifier.text;
                const importedNames: string[] = [];

                if (node.importClause) {
                    // Named imports
                    if (node.importClause.namedBindings && ts.isNamedImports(node.importClause.namedBindings)) {
                        for (const element of node.importClause.namedBindings.elements) {
                            importedNames.push(element.name.text);
                        }
                    }

                    // Namespace imports
                    if (node.importClause.namedBindings && ts.isNamespaceImport(node.importClause.namedBindings)) {
                        importedNames.push(node.importClause.namedBindings.name.text);
                    }

                    // Default import
                    if (node.importClause.name) {
                        importedNames.push(node.importClause.name.text);
                    }
                }

                imports.push({ modulePath, importedNames });
            }

            // 🔁 Recursively visit child nodes
            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return imports;
    }


    private resolveObjectType(expression: ts.Expression, sourceFile: ts.SourceFile): { className: string, filePath: string } | null {
        if (!this.checker) return null;

        try {
            const type = this.checker.getTypeAtLocation(expression);
            const symbol = type.getSymbol();

            if (symbol && symbol.declarations) {
                for (const declaration of symbol.declarations) {
                    const sourceFile = declaration.getSourceFile();
                    if (ts.isClassDeclaration(declaration) && declaration.name) {
                        return {
                            className: declaration.name.text,
                            filePath: sourceFile.fileName
                        };
                    }
                }
            }
        } catch (error) {
            // TypeChecker failed, return null
        }

        return null;
    }

    private buildCallChain(
        functionId: string,
        functionCallMap: Map<string, Set<string>>,
        nodes: GraphNode[],
        edges: GraphEdge[],
        visitedFunctions: Set<string>,
        depth: number = 0
    ) {
        if (visitedFunctions.has(functionId) || depth > 15) { // Increased depth limit
            return;
        }

        visitedFunctions.add(functionId);
        const calls = functionCallMap.get(functionId);

        if (!calls) return;

        calls.forEach(calledFunctionId => {
            // Skip unknown functions that we couldn't resolve
            if (calledFunctionId.includes('function:unknown:')) {
                // Still add the unknown node for completeness, but don't recurse
                if (!nodes.find(n => n.id === calledFunctionId)) {
                    const unknownFunction = this.createUnknownFunctionNode(calledFunctionId);
                    if (unknownFunction) {
                        nodes.push(unknownFunction);
                    }
                }

                // Add call edge
                if (!edges.find(e => e.source === functionId && e.target === calledFunctionId)) {
                    edges.push({
                        source: functionId,
                        target: calledFunctionId,
                        type: 'calls'
                    });
                }
                return;
            }

            // Add the called function node if it doesn't exist
            if (!nodes.find(n => n.id === calledFunctionId)) {
                const calledFunction = this.createFunctionNode(calledFunctionId);

                if (calledFunction) {
                    nodes.push(calledFunction);

                    // Add file node if it's from a different file
                    const filePath = calledFunction.filePath;
                    const fileNodeId = `file:${filePath}`;
                    if (!nodes.find(n => n.id === fileNodeId)) {
                        const fileNode: GraphNode = {
                            id: fileNodeId,
                            name: path.basename(filePath),
                            type: 'file',
                            filePath: filePath
                        };
                        nodes.push(fileNode);
                    }

                    // Connect function to its file
                    if (!edges.find(e => e.source === fileNodeId && e.target === calledFunctionId)) {
                        edges.push({
                            source: fileNodeId,
                            target: calledFunctionId,
                            type: 'contains'
                        });
                    }
                }
            }

            // Add call edge
            if (!edges.find(e => e.source === functionId && e.target === calledFunctionId)) {
                edges.push({
                    source: functionId,
                    target: calledFunctionId,
                    type: 'calls'
                });
            }

            // Recursively build call chain
            this.buildCallChain(calledFunctionId, functionCallMap, nodes, edges, visitedFunctions, depth + 1);
        });
    }

    private createUnknownFunctionNode(functionId: string): GraphNode | null {
        const parts = functionId.split(':');
        if (parts.length < 3) return null;

        const functionName = parts[2];

        return {
            id: functionId,
            name: functionName,
            type: 'function',
            filePath: 'unknown',
            isExternal: true
        };
    }

    private createFunctionNode(functionId: string): GraphNode | null {
        const parts = functionId.split(':');
        if (parts.length < 3) return null;

        const [type, filePath, ...nameParts] = parts;
        const name = nameParts.join(':');

        // Try to get position information
        const sourceFile = this.program!.getSourceFile(filePath);
        let line: number | undefined;
        let column: number | undefined;

        if (sourceFile) {
            if (type === 'function') {
                const position = this.findFunctionPosition(sourceFile, name);
                line = position?.line;
                column = position?.column;
            } else if (type === 'method') {
                const [className, methodName] = nameParts;
                const position = this.findMethodPosition(sourceFile, className, methodName);
                line = position?.line;
                column = position?.column;
            }
        }

        return {
            id: functionId,
            name: name,
            type: type === 'method' ? 'function' : type as any,
            filePath: filePath,
            line: line,
            column: column
        };
    }

    private findFunctionPosition(sourceFile: ts.SourceFile, functionName: string): { line: number, column: number } | null {
        let result: { line: number, column: number } | null = null;

        const visit = (node: ts.Node) => {
            // Function declarations
            if (ts.isFunctionDeclaration(node) && node.name && node.name.text === functionName) {
                const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
                result = { line: pos.line, column: pos.character };
                return;
            }

            // Arrow functions and function expressions
            if (ts.isVariableDeclaration(node) &&
                ts.isIdentifier(node.name) &&
                node.name.text === functionName &&
                node.initializer &&
                (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer))) {
                const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
                result = { line: pos.line, column: pos.character };
                return;
            }

            if (!result) {
                ts.forEachChild(node, visit);
            }
        };

        visit(sourceFile);
        return result;
    }

    private findMethodPosition(sourceFile: ts.SourceFile, className: string, methodName: string): { line: number, column: number } | null {
        let result: { line: number, column: number } | null = null;

        const visit = (node: ts.Node) => {
            if (ts.isClassDeclaration(node) && node.name && node.name.text === className) {
                for (const member of node.members) {
                    if (ts.isMethodDeclaration(member) &&
                        ts.isIdentifier(member.name) &&
                        member.name.text === methodName) {
                        const pos = sourceFile.getLineAndCharacterOfPosition(member.getStart());
                        result = { line: pos.line, column: pos.character };
                        return;
                    }
                }
            }

            if (!result) {
                ts.forEachChild(node, visit);
            }
        };

        visit(sourceFile);
        return result;
    }

    private extractFunctionsFromFile(sourceFile: ts.SourceFile): GraphNode[] {
        const functions: GraphNode[] = [];
        const filePath = sourceFile.fileName;

        const visit = (node: ts.Node) => {
            // Handle function declarations
            if (ts.isFunctionDeclaration(node) && node.name) {
                const functionNode: GraphNode = {
                    id: `function:${filePath}:${node.name.text}`,
                    name: node.name.text,
                    type: 'function',
                    filePath: filePath,
                    line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line,
                    column: sourceFile.getLineAndCharacterOfPosition(node.getStart()).character
                };
                functions.push(functionNode);
            }

            // Handle arrow functions and function expressions assigned to variables
            if (ts.isVariableDeclaration(node) && node.initializer &&
                (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) &&
                ts.isIdentifier(node.name)) {
                const functionNode: GraphNode = {
                    id: `function:${filePath}:${node.name.text}`,
                    name: node.name.text,
                    type: 'function',
                    filePath: filePath,
                    line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line,
                    column: sourceFile.getLineAndCharacterOfPosition(node.getStart()).character
                };
                functions.push(functionNode);
            }

            // Handle class methods
            if (ts.isClassDeclaration(node) && node.name) {
                for (const member of node.members) {
                    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
                        const methodNode: GraphNode = {
                            id: `method:${filePath}:${node.name.text}:${member.name.text}`,
                            name: `${node.name.text}.${member.name.text}`,
                            type: 'function',
                            filePath: filePath,
                            line: sourceFile.getLineAndCharacterOfPosition(member.getStart()).line,
                            column: sourceFile.getLineAndCharacterOfPosition(member.getStart()).character
                        };
                        functions.push(methodNode);
                    }
                }
            }

            ts.forEachChild(node, visit);
        };

        visit(sourceFile);
        return functions;
    }

    private resolveImportPath(importPath: string, currentFile: string): string | null {
        if (importPath.startsWith('.')) {
            // Relative import
            const resolved = path.resolve(path.dirname(currentFile), importPath);

            // Try different extensions
            const extensions = ['.ts', '.tsx', '.js', '.jsx'];
            for (const ext of extensions) {
                const fullPath = resolved + ext;
                if (fs.existsSync(fullPath)) {
                    return fullPath;
                }
            }

            // Try index files
            for (const ext of extensions) {
                const indexPath = path.join(resolved, 'index' + ext);
                if (fs.existsSync(indexPath)) {
                    return indexPath;
                }
            }
        } else {
            // Try to resolve node_modules or absolute paths
            // For now, we'll skip node_modules resolution to avoid external dependencies
            // unless they're explicitly in our workspace
        }
        return null;
    }

    private async getTypeScriptFiles(workspacePath: string): Promise<string[]> {
        const files: string[] = [];

        if (!fs.existsSync(workspacePath)) {
            throw new Error(`Path does not exist: ${workspacePath}`);
        }

        const stats = fs.statSync(workspacePath);

        if (stats.isFile()) {
            if (/\.(ts|tsx|js|jsx)$/.test(workspacePath) && !workspacePath.endsWith('.d.ts')) {
                return [workspacePath];
            } else {
                throw new Error('The selected file is not a TypeScript or JavaScript file');
            }
        }

        const walkDir = (dir: string) => {
            try {
                const entries = fs.readdirSync(dir, { withFileTypes: true });

                for (const entry of entries) {
                    const fullPath = path.join(dir, entry.name);

                    if (entry.isDirectory()) {
                        if (!['node_modules', '.git', 'dist', 'build', 'out', '.vscode', '.next'].includes(entry.name)) {
                            walkDir(fullPath);
                        }
                    } else if (entry.isFile()) {
                        if (/\.(ts|tsx|js|jsx)$/.test(entry.name) && !entry.name.endsWith('.d.ts')) {
                            files.push(fullPath);
                        }
                    }
                }
            } catch (error) {
                console.warn(`Error reading directory ${dir}:`, error);
            }
        };

        walkDir(workspacePath);
        return files;
    }

    // Legacy method for backward compatibility
    public async analyzeWorkspace(workspacePath: string): Promise<GraphData> {
        const activeEditor = vscode.window.activeTextEditor;
        if (activeEditor) {
            return this.analyzeActiveFile(activeEditor.document.uri.fsPath, workspacePath);
        }

        // Fallback to first TypeScript file found
        const files = await this.getTypeScriptFiles(workspacePath);
        if (files.length > 0) {
            return this.analyzeActiveFile(files[0], workspacePath);
        }

        return { nodes: [], edges: [] };
    }

    public async analyzeFile(filePath: string): Promise<GraphData> {
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const workspacePath = workspaceFolder ? workspaceFolder.uri.fsPath : undefined;
        return this.analyzeActiveFile(filePath, workspacePath);
    }

    // Additional utility methods for debugging
    public getProcessedFilesCount(): number {
        return this.processedFiles.size;
    }

    public getImportGraph(): Map<string, Set<string>> {
        return new Map(this.importGraph);
    }

    public clearCache(): void {
        this.astCache.clear();
        this.processedFiles.clear();
        this.importGraph.clear();
    }
}