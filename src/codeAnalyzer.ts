import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GraphData, GraphNode, GraphEdge } from './types';

export class CodeAnalyzer {
    private program?: ts.Program;
    private checker?: ts.TypeChecker;
    private astCache = new Map<string, ts.SourceFile>();

    public async analyzeActiveFile(activeFilePath: string, workspacePath?: string): Promise<GraphData> {
        // Get all TypeScript files in workspace for context
        let allFiles: string[] = [];
        
        if (workspacePath) {
            try {
                allFiles = await this.getTypeScriptFiles(workspacePath);
            } catch (error) {
                console.warn('Error getting workspace files, analyzing single file:', error);
                allFiles = [activeFilePath];
            }
        } else {
            allFiles = [activeFilePath];
        }

        // Create TypeScript program with all files for proper type checking
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

        this.program = ts.createProgram(allFiles, compilerOptions);
        this.checker = this.program.getTypeChecker();

        // Analyze the active file and build call graph
        return this.buildCallGraphFromActiveFile(activeFilePath);
    }

    private buildCallGraphFromActiveFile(activeFilePath: string): GraphData {
        const nodes: GraphNode[] = [];
        const edges: GraphEdge[] = [];
        const visitedFunctions = new Set<string>();
        const functionCallMap = new Map<string, Set<string>>();

        // First pass: collect all functions and their calls across all files
        this.collectAllFunctions(functionCallMap);

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
        for (const sourceFile of this.program!.getSourceFiles()) {
            if (sourceFile.isDeclarationFile) continue;
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
            if (this.functionExists(targetId)) {
                return targetId;
            }

            // Try to resolve in imported files
            const importedTarget = this.resolveImportedFunction(functionName, sourceFile);
            if (importedTarget) {
                return importedTarget;
            }

            // If not found, create a placeholder (might be from external library)
            return `function:unknown:${functionName}`;
        }

        if (ts.isPropertyAccessExpression(callExpression.expression)) {
            // Method call like obj.method()
            if (ts.isIdentifier(callExpression.expression.name)) {
                const methodName = callExpression.expression.name.text;
                
                // Try to resolve the object type and method
                const objectType = this.resolveObjectType(callExpression.expression.expression, sourceFile);
                if (objectType) {
                    return `method:${objectType.filePath}:${objectType.className}:${methodName}`;
                }
            }
        }

        return null;
    }

    private functionExists(functionId: string): boolean {
        const [, filePath, functionName] = functionId.split(':');
        const sourceFile = this.program!.getSourceFile(filePath);
        if (!sourceFile) return false;

        let found = false;
        const visit = (node: ts.Node) => {
            if (ts.isFunctionDeclaration(node) && node.name && node.name.text === functionName) {
                found = true;
                return;
            }
            if (!found) {
                ts.forEachChild(node, visit);
            }
        };

        visit(sourceFile);
        return found;
    }

    private resolveImportedFunction(functionName: string, sourceFile: ts.SourceFile): string | null {
        // Find import statements and resolve function location
        const imports = this.getImportsFromFile(sourceFile);
        
        for (const importInfo of imports) {
            if (importInfo.importedNames.includes(functionName)) {
                const targetFile = this.resolveImportPath(importInfo.modulePath, sourceFile.fileName);
                if (targetFile) {
                    return `function:${targetFile}:${functionName}`;
                }
            }
        }

        return null;
    }

    private getImportsFromFile(sourceFile: ts.SourceFile): Array<{modulePath: string, importedNames: string[]}> {
        const imports: Array<{modulePath: string, importedNames: string[]}> = [];

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
                    
                    // Default import
                    if (node.importClause.name) {
                        importedNames.push(node.importClause.name.text);
                    }
                }

                imports.push({ modulePath, importedNames });
            }
        };

        visit(sourceFile);
        return imports;
    }

    private resolveObjectType(expression: ts.Expression, sourceFile: ts.SourceFile): {className: string, filePath: string} | null {
        // This is a simplified version - in a real implementation, you'd use the TypeChecker
        if (ts.isIdentifier(expression)) {
            // Try to find the variable declaration and its type
            // For now, return null as this requires more complex type resolution
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
        if (visitedFunctions.has(functionId) || depth > 10) { // Prevent infinite recursion
            return;
        }

        visitedFunctions.add(functionId);
        const calls = functionCallMap.get(functionId);
        
        if (!calls) return;

        calls.forEach(calledFunctionId => {
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

    private createFunctionNode(functionId: string): GraphNode | null {
        const parts = functionId.split(':');
        if (parts.length < 3) return null;

        const [type, filePath, ...nameParts] = parts;
        const name = nameParts.join(':');

        // Try to get position information
        const sourceFile = this.program!.getSourceFile(filePath);
        let line: number | undefined;
        let column: number | undefined;

        if (sourceFile && type === 'function') {
            const position = this.findFunctionPosition(sourceFile, name);
            line = position?.line;
            column = position?.column;
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

    private findFunctionPosition(sourceFile: ts.SourceFile, functionName: string): {line: number, column: number} | null {
        let result: {line: number, column: number} | null = null;

        const visit = (node: ts.Node) => {
            if (ts.isFunctionDeclaration(node) && node.name && node.name.text === functionName) {
                const pos = sourceFile.getLineAndCharacterOfPosition(node.getStart());
                result = { line: pos.line, column: pos.character };
                return;
            }
            
            if (ts.isMethodDeclaration(node) && node.name && ts.isIdentifier(node.name) && node.name.text === functionName) {
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
}