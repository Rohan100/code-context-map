export interface GraphNode {
    id: string;
    name: string;
    type: 'file' | 'function' | 'class' | 'variable' | 'interface' | 'enum';
    filePath: string;
    line?: number;
    column?: number;
    size?: number;
    dependencies?: string[];
    isActiveFile?: boolean;
    isExternal?: boolean;
}

export interface GraphEdge {
    source: string;
    target: string;
    type: 'import' | 'export' | 'calls' | 'extends' | 'implements' | 'contains' | 'references';
    weight?: number;
}

export interface GraphData {
    nodes: GraphNode[];
    edges: GraphEdge[];
}

export interface CodeContext {
    filePath: string;
    functionName?: string;
    className?: string;
    line: number;
    column: number;
}

export interface ParsedFile {
    filePath: string;
    imports: string[];
    exports: string[];
    functions: string[];
    classes: string[];
    variables: string[];
    dependencies: string[];
}

export interface AnalysisResult {
    files: ParsedFile[];
    relationships: GraphEdge[];
    metrics: {
        totalFiles: number;
        totalFunctions: number;
        totalClasses: number;
        complexity: number;
    };
}