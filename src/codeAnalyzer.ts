import * as ts from 'typescript';
import * as fs from 'fs';
import * as path from 'path';
import * as vscode from 'vscode';
import { GraphData, GraphNode, GraphEdge } from './types';

export class CodeAnalyzer {
    private program?: ts.Program;
    private checker?: ts.TypeChecker;
    private astCache = new Map<string, ts.SourceFile>();

    public async analyzeWorkspace(workspacePath: string): Promise<GraphData> {
        const tsConfigPath = this.findTsConfig(workspacePath);
        let fileList: string[];
        
        try {
            fileList = await this.getTypeScriptFiles(workspacePath);
        } catch (error) {
            console.warn('Error getting TypeScript files, falling back to single file analysis:', error);
            
            // If we can't scan the directory, try to analyze just the current file
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor && (activeEditor.document.languageId === 'typescript' || activeEditor.document.languageId === 'javascript')) {
                fileList = [activeEditor.document.uri.fsPath];
            } else {
                throw new Error('No TypeScript/JavaScript files found to analyze');
            }
        }

        if (fileList.length === 0) {
            throw new Error('No TypeScript/JavaScript files found in the workspace');
        }
        
        // Create TypeScript program
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

        if (tsConfigPath) {
            try {
                const configFile = ts.readConfigFile(tsConfigPath, ts.sys.readFile);
                const parsedConfig = ts.parseJsonConfigFileContent(
                    configFile.config,
                    ts.sys,
                    path.dirname(tsConfigPath)
                );
                Object.assign(compilerOptions, parsedConfig.options);
            } catch (error) {
                console.warn('Error parsing tsconfig.json, using default options:', error);
            }
        }

        this.program = ts.createProgram(fileList, compilerOptions);
        this.checker = this.program.getTypeChecker();

        return this.analyzeProgram();
    }

    public async analyzeFile(filePath: string): Promise<GraphData> {
        if (!this.program || !this.checker) {
            // If no program exists, create a minimal one for this file
            const compilerOptions: ts.CompilerOptions = {
                target: ts.ScriptTarget.ES2020,
                module: ts.ModuleKind.CommonJS,
                allowJs: true
            };
            
            this.program = ts.createProgram([filePath], compilerOptions);
            this.checker = this.program.getTypeChecker();
        }

        const sourceFile = this.program.getSourceFile(filePath);
        if (!sourceFile) {
            return { nodes: [], edges: [] };
        }

        return this.analyzeSourceFile(sourceFile);
    }

    private analyzeProgram(): GraphData {
        const nodes: GraphNode[] = [];
        const edges: GraphEdge[] = [];

        for (const sourceFile of this.program!.getSourceFiles()) {
            if (sourceFile.isDeclarationFile) continue;

            const fileData = this.analyzeSourceFile(sourceFile);
            nodes.push(...fileData.nodes);
            edges.push(...fileData.edges);
        }

        return { nodes, edges };
    }

    private analyzeSourceFile(sourceFile: ts.SourceFile): GraphData {
        const nodes: GraphNode[] = [];
        const edges: GraphEdge[] = [];
        const filePath = sourceFile.fileName;

        // Add file node
        const fileNode: GraphNode = {
            id: `file:${filePath}`,
            name: path.basename(filePath),
            type: 'file',
            filePath: filePath
        };
        nodes.push(fileNode);

        // Analyze the AST
        const visit = (node: ts.Node) => {
            // Handle imports
            if (ts.isImportDeclaration(node) && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
                const importPath = this.resolveImportPath(node.moduleSpecifier.text, filePath);
                if (importPath) {
                    edges.push({
                        source: `file:${filePath}`,
                        target: `file:${importPath}`,
                        type: 'import'
                    });
                }
            }

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
                nodes.push(functionNode);

                // Connect function to file
                edges.push({
                    source: `file:${filePath}`,
                    target: functionNode.id,
                    type: 'contains'
                });
            }

            // Handle class declarations
            if (ts.isClassDeclaration(node) && node.name) {
                const classNode: GraphNode = {
                    id: `class:${filePath}:${node.name.text}`,
                    name: node.name.text,
                    type: 'class',
                    filePath: filePath,
                    line: sourceFile.getLineAndCharacterOfPosition(node.getStart()).line,
                    column: sourceFile.getLineAndCharacterOfPosition(node.getStart()).character
                };
                nodes.push(classNode);

                // Connect class to file
                edges.push({
                    source: `file:${filePath}`,
                    target: classNode.id,
                    type: 'contains'
                });

                // Handle inheritance
                if (node.heritageClauses) {
                    for (const heritage of node.heritageClauses) {
                        if (heritage.token === ts.SyntaxKind.ExtendsKeyword) {
                            for (const type of heritage.types) {
                                if (ts.isIdentifier(type.expression)) {
                                    // This is a simplified approach - in reality, you'd need to resolve the type
                                    edges.push({
                                        source: classNode.id,
                                        target: `class:${filePath}:${type.expression.text}`,
                                        type: 'extends'
                                    });
                                }
                            }
                        }
                    }
                }

                // Analyze class members
                for (const member of node.members) {
                    if (ts.isMethodDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
                        const methodNode: GraphNode = {
                            id: `method:${filePath}:${node.name.text}:${member.name.text}`,
                            name: member.name.text,
                            type: 'function',
                            filePath: filePath,
                            line: sourceFile.getLineAndCharacterOfPosition(member.getStart()).line,
                            column: sourceFile.getLineAndCharacterOfPosition(member.getStart()).character
                        };
                        nodes.push(methodNode);

                        // Connect method to class
                        edges.push({
                            source: classNode.id,
                            target: methodNode.id,
                            type: 'contains'
                        });
                    }

                    if (ts.isPropertyDeclaration(member) && member.name && ts.isIdentifier(member.name)) {
                        const propertyNode: GraphNode = {
                            id: `property:${filePath}:${node.name.text}:${member.name.text}`,
                            name: member.name.text,
                            type: 'variable',
                            filePath: filePath,
                            line: sourceFile.getLineAndCharacterOfPosition(member.getStart()).line,
                            column: sourceFile.getLineAndCharacterOfPosition(member.getStart()).character
                        };
                        nodes.push(propertyNode);

                        // Connect property to class
                        edges.push({
                            source: classNode.id,
                            target: propertyNode.id,
                            type: 'contains'
                        });
                    }
                }
            }

            // Handle variable declarations
            if (ts.isVariableStatement(node)) {
                for (const declaration of node.declarationList.declarations) {
                    if (ts.isIdentifier(declaration.name)) {
                        const variableNode: GraphNode = {
                            id: `variable:${filePath}:${declaration.name.text}`,
                            name: declaration.name.text,
                            type: 'variable',
                            filePath: filePath,
                            line: sourceFile.getLineAndCharacterOfPosition(declaration.getStart()).line,
                            column: sourceFile.getLineAndCharacterOfPosition(declaration.getStart()).character
                        };
                        nodes.push(variableNode);

                        // Connect variable to file
                        edges.push({
                            source: `file:${filePath}`,
                            target: variableNode.id,
                            type: 'contains'
                        });
                    }
                }
            }

            // Handle function calls
            if (ts.isCallExpression(node)) {
                if (ts.isIdentifier(node.expression)) {
                    const callerContext = this.findContainingFunction(node, sourceFile);
                    if (callerContext) {
                        edges.push({
                            source: callerContext,
                            target: `function:${filePath}:${node.expression.text}`,
                            type: 'calls'
                        });
                    }
                }
            }

            ts.forEachChild(node, visit);
        };

        visit(sourceFile);

        return { nodes, edges };
    }

    private findContainingFunction(node: ts.Node, sourceFile: ts.SourceFile): string | null {
        let current = node.parent;
        while (current) {
            if (ts.isFunctionDeclaration(current) && current.name) {
                return `function:${sourceFile.fileName}:${current.name.text}`;
            }
            if (ts.isMethodDeclaration(current) && current.name && ts.isIdentifier(current.name)) {
                const classDeclaration = current.parent;
                if (ts.isClassDeclaration(classDeclaration) && classDeclaration.name) {
                    return `method:${sourceFile.fileName}:${classDeclaration.name.text}:${current.name.text}`;
                }
            }
            current = current.parent;
        }
        return null;
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

    private findTsConfig(workspacePath: string): string | null {
        const tsConfigPath = path.join(workspacePath, 'tsconfig.json');
        return fs.existsSync(tsConfigPath) ? tsConfigPath : null;
    }

    private async getTypeScriptFiles(workspacePath: string): Promise<string[]> {
        const files: string[] = [];
        
        // Check if the path exists and is accessible
        if (!fs.existsSync(workspacePath)) {
            throw new Error(`Path does not exist: ${workspacePath}`);
        }

        const stats = fs.statSync(workspacePath);
        
        // If it's a single file, just return that file
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
                        // Skip node_modules and other common directories
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
                // Continue with other directories
            }
        };
        
        walkDir(workspacePath);
        return files;
    }
}