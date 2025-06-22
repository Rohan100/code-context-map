import * as vscode from 'vscode';
import * as path from 'path';
import { CodeAnalyzer } from './codeAnalyzer';
import { GraphData, GraphNode, GraphEdge } from './types';

export class CodeContextProvider implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private analyzer: CodeAnalyzer;
    private currentGraphData?: GraphData;

    constructor(private readonly extensionUri: vscode.Uri) {
        this.analyzer = new CodeAnalyzer();
    }

    public async showCodeMap() {
        // Check if we have a workspace or active file
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        const activeEditor = vscode.window.activeTextEditor;
        
        if (!workspaceFolder && !activeEditor) {
            vscode.window.showErrorMessage(
                'Please open a folder or a TypeScript/JavaScript file to use Code Context Navigator'
            );
            return;
        }

        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside);
            return;
        }

        this.panel = vscode.window.createWebviewPanel(
            'codeContextNavigator',
            'Code Context Map',
            vscode.ViewColumn.Beside,
            {
                enableScripts: true,
                retainContextWhenHidden: true,
                localResourceRoots: [this.extensionUri]
            }
        );

        this.panel.webview.html = this.getWebviewContent();

        // Handle messages from the webview
        this.panel.webview.onDidReceiveMessage(
            async (message) => {
                switch (message.command) {
                    case 'navigateToNode':
                        await this.navigateToNode(message.nodeId);
                        break;
                    case 'showReferences':
                        await this.showReferences(message.nodeId);
                        break;
                    case 'ready':
                        await this.refreshMap();
                        break;
                }
            }
        );

        this.panel.onDidDispose(() => {
            this.panel = undefined;
        });
    }

    public async refreshMap() {
        if (!this.panel) {
            return;
        }

        // Try to get workspace folder, or use current file's directory
        let workspacePath: string | undefined;
        
        const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
        if (workspaceFolder) {
            workspacePath = workspaceFolder.uri.fsPath;
        } else {
            // If no workspace, try to use the current active file's directory
            const activeEditor = vscode.window.activeTextEditor;
            if (activeEditor) {
                const currentFilePath = activeEditor.document.uri.fsPath;
                workspacePath = path.dirname(currentFilePath);
                
                // Show info message about limited scope
                vscode.window.showInformationMessage(
                    'No workspace folder found. Analyzing current file directory: ' + path.basename(workspacePath)
                );
            } else {
                vscode.window.showErrorMessage(
                    'No workspace folder found and no active file. Please open a folder or file to analyze.'
                );
                return;
            }
        }

        try {
            this.currentGraphData = await this.analyzer.analyzeWorkspace(workspacePath);
            this.panel.webview.postMessage({
                command: 'updateGraph',
                data: this.currentGraphData
            });
        } catch (error) {
            console.error('Error analyzing workspace:', error);
            vscode.window.showErrorMessage('Error analyzing workspace: ' + error);
        }
    }

    public async onFileChanged(uri: vscode.Uri) {
        if (!this.panel || !this.currentGraphData) {
            return;
        }

        try {
            const updatedData = await this.analyzer.analyzeFile(uri.fsPath);
            // Merge the updated data with current graph data
            this.mergeGraphData(updatedData);
            
            this.panel.webview.postMessage({
                command: 'updateGraph',
                data: this.currentGraphData
            });
        } catch (error) {
            console.error('Error analyzing changed file:', error);
        }
    }

    public onFileDeleted(uri: vscode.Uri) {
        if (!this.panel || !this.currentGraphData) {
            return;
        }

        // Remove nodes and edges related to the deleted file
        const filePath = uri.fsPath;
        this.currentGraphData.nodes = this.currentGraphData.nodes.filter(node => node.filePath !== filePath);
        this.currentGraphData.edges = this.currentGraphData.edges.filter(edge => 
            !edge.source.includes(filePath) && !edge.target.includes(filePath)
        );

        this.panel.webview.postMessage({
            command: 'updateGraph',
            data: this.currentGraphData
        });
    }

    public onActiveEditorChanged(editor: vscode.TextEditor) {
        if (!this.panel) {
            return;
        }

        const filePath = editor.document.uri.fsPath;
        this.panel.webview.postMessage({
            command: 'highlightFile',
            filePath: filePath
        });
    }

    private async navigateToNode(nodeId: string) {
        if (!this.currentGraphData) {
            return;
        }

        const node = this.currentGraphData.nodes.find(n => n.id === nodeId);
        if (!node) {
            return;
        }

        try {
            const document = await vscode.workspace.openTextDocument(node.filePath);
            const editor = await vscode.window.showTextDocument(document);
            
            if (node.line !== undefined) {
                const position = new vscode.Position(node.line, node.column || 0);
                editor.selection = new vscode.Selection(position, position);
                editor.revealRange(new vscode.Range(position, position));
            }
        } catch (error) {
            vscode.window.showErrorMessage('Could not open file: ' + error);
        }
    }

    private async showReferences(nodeId: string) {
        if (!this.currentGraphData) {
            return;
        }

        const node = this.currentGraphData.nodes.find(n => n.id === nodeId);
        if (!node) {
            return;
        }

        try {
            const document = await vscode.workspace.openTextDocument(node.filePath);
            const position = new vscode.Position(node.line || 0, node.column || 0);
            
            await vscode.commands.executeCommand('editor.action.goToReferences', 
                document.uri, position);
        } catch (error) {
            vscode.window.showErrorMessage('Could not show references: ' + error);
        }
    }

    private mergeGraphData(newData: GraphData) {
        if (!this.currentGraphData) {
            this.currentGraphData = newData;
            return;
        }

        // Simple merge strategy - replace nodes from the same file
        const newFilePaths = new Set(newData.nodes.map(n => n.filePath));
        
        // Remove old nodes from the same files
        this.currentGraphData.nodes = this.currentGraphData.nodes.filter(
            node => !newFilePaths.has(node.filePath)
        );
        
        // Add new nodes
        this.currentGraphData.nodes.push(...newData.nodes);
        
        // Remove old edges involving the updated files
        this.currentGraphData.edges = this.currentGraphData.edges.filter(
            edge => !newFilePaths.has(edge.source.split(':')[0]) && 
                   !newFilePaths.has(edge.target.split(':')[0])
        );
        
        // Add new edges
        this.currentGraphData.edges.push(...newData.edges);
    }

    private getWebviewContent(): string {
        return `
<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>Code Context Map</title>
    <script src="https://cdnjs.cloudflare.com/ajax/libs/d3/7.8.5/d3.min.js"></script>
    <style>
        body {
            margin: 0;
            padding: 0;
            background-color: var(--vscode-editor-background);
            color: var(--vscode-editor-foreground);
            font-family: var(--vscode-font-family);
            overflow: hidden;
        }
        
        #graph-container {
            width: 100vw;
            height: 100vh;
            position: relative;
        }
        
        .node {
            cursor: pointer;
            stroke-width: 2;
        }
        
        .node.file {
            fill: var(--vscode-charts-blue);
            stroke: var(--vscode-charts-blue);
        }
        
        .node.function {
            fill: var(--vscode-charts-green);
            stroke: var(--vscode-charts-green);
        }
        
        .node.class {
            fill: var(--vscode-charts-orange);
            stroke: var(--vscode-charts-orange);
        }
        
        .node.variable {
            fill: var(--vscode-charts-purple);
            stroke: var(--vscode-charts-purple);
        }
        
        .node.highlighted {
            stroke: var(--vscode-charts-red);
            stroke-width: 3;
        }
        
        .link {
            stroke: var(--vscode-charts-foreground);
            stroke-opacity: 0.6;
            stroke-width: 1;
        }
        
        .node-label {
            font-size: 10px;
            fill: var(--vscode-editor-foreground);
            text-anchor: middle;
            pointer-events: none;
        }
        
        .tooltip {
            position: absolute;
            padding: 8px;
            background: var(--vscode-hover-background);
            border: 1px solid var(--vscode-hover-border);
            border-radius: 4px;
            font-size: 12px;
            pointer-events: none;
            opacity: 0;
            transition: opacity 0.2s;
            z-index: 1000;
        }
        
        .controls {
            position: absolute;
            top: 10px;
            left: 10px;
            z-index: 100;
        }
        
        .control-button {
            background: var(--vscode-button-background);
            color: var(--vscode-button-foreground);
            border: none;
            padding: 8px 12px;
            margin-right: 8px;
            border-radius: 4px;
            cursor: pointer;
            font-size: 12px;
        }
        
        .control-button:hover {
            background: var(--vscode-button-hoverBackground);
        }
    </style>
</head>
<body>
    <div id="graph-container">
        <div class="controls">
            <button class="control-button" onclick="resetZoom()">Reset Zoom</button>
            <button class="control-button" onclick="toggleLabels()">Toggle Labels</button>
        </div>
        <svg id="graph"></svg>
        <div class="tooltip" id="tooltip"></div>
    </div>

    <script>
        const vscode = acquireVsCodeApi();
        
        let svg, simulation, nodes, links, nodeElements, linkElements, labelElements;
        let graphData = { nodes: [], edges: [] };
        let showLabels = true;
        
        // Initialize the graph
        function initGraph() {
            const container = d3.select('#graph-container');
            const rect = container.node().getBoundingClientRect();
            
            svg = d3.select('#graph')
                .attr('width', rect.width)
                .attr('height', rect.height);
            
            // Add zoom behavior
            const zoom = d3.zoom()
                .scaleExtent([0.1, 10])
                .on('zoom', (event) => {
                    svg.select('.graph-group').attr('transform', event.transform);
                });
            
            svg.call(zoom);
            
            // Create main group for graph elements
            svg.append('g').attr('class', 'graph-group');
            
            // Initialize simulation
            simulation = d3.forceSimulation()
                .force('link', d3.forceLink().id(d => d.id).distance(100))
                .force('charge', d3.forceManyBody().strength(-300))
                .force('center', d3.forceCenter(rect.width / 2, rect.height / 2))
                .force('collision', d3.forceCollide().radius(30));
        }
        
        function updateGraph(data) {
            graphData = data;
            
            // Process nodes
            nodes = data.nodes.map(node => ({
                ...node,
                id: node.id,
                x: Math.random() * 800,
                y: Math.random() * 600
            }));
            
            // Process links
            links = data.edges.map(edge => ({
                source: edge.source,
                target: edge.target,
                type: edge.type
            }));
            
            // Update the visualization
            updateVisualization();
        }
        
        function updateVisualization() {
            const graphGroup = svg.select('.graph-group');
            
            // Update links
            linkElements = graphGroup.selectAll('.link')
                .data(links, d => d.source + '-' + d.target);
            
            linkElements.exit().remove();
            
            linkElements = linkElements.enter()
                .append('line')
                .attr('class', 'link')
                .merge(linkElements);
            
            // Update nodes
            nodeElements = graphGroup.selectAll('.node')
                .data(nodes, d => d.id);
            
            nodeElements.exit().remove();
            
            const nodeEnter = nodeElements.enter()
                .append('g')
                .attr('class', 'node-group');
            
            // Add shapes based on node type
            nodeEnter.each(function(d) {
                const group = d3.select(this);
                
                if (d.type === 'file') {
                    group.append('rect')
                        .attr('width', 20)
                        .attr('height', 15)
                        .attr('x', -10)
                        .attr('y', -7.5);
                } else if (d.type === 'class') {
                    group.append('polygon')
                        .attr('points', '0,-12 12,0 0,12 -12,0');
                } else {
                    group.append('circle')
                        .attr('r', 8);
                }
            });
            
            nodeElements = nodeEnter.merge(nodeElements);
            
            nodeElements.selectAll('rect, circle, polygon')
                .attr('class', d => \`node \${d.type}\`)
                .on('click', function(event, d) {
                    vscode.postMessage({
                        command: 'navigateToNode',
                        nodeId: d.id
                    });
                })
                .on('contextmenu', function(event, d) {
                    event.preventDefault();
                    vscode.postMessage({
                        command: 'showReferences',
                        nodeId: d.id
                    });
                })
                .on('mouseover', function(event, d) {
                    showTooltip(event, d);
                })
                .on('mouseout', function() {
                    hideTooltip();
                });
            
            // Update labels
            labelElements = graphGroup.selectAll('.node-label')
                .data(nodes, d => d.id);
            
            labelElements.exit().remove();
            
            labelElements = labelElements.enter()
                .append('text')
                .attr('class', 'node-label')
                .merge(labelElements)
                .text(d => d.name)
                .style('display', showLabels ? 'block' : 'none');
            
            // Update simulation
            simulation.nodes(nodes);
            simulation.force('link').links(links);
            simulation.alpha(1).restart();
            
            // Set up tick handler
            simulation.on('tick', () => {
                linkElements
                    .attr('x1', d => d.source.x)
                    .attr('y1', d => d.source.y)
                    .attr('x2', d => d.target.x)
                    .attr('y2', d => d.target.y);
                
                nodeElements
                    .attr('transform', d => \`translate(\${d.x},\${d.y})\`);
                
                labelElements
                    .attr('x', d => d.x)
                    .attr('y', d => d.y + 20);
            });
        }
        
        function showTooltip(event, d) {
            const tooltip = d3.select('#tooltip');
            tooltip.html(\`
                <strong>\${d.name}</strong><br/>
                Type: \${d.type}<br/>
                File: \${d.filePath.split('/').pop()}<br/>
                \${d.line ? \`Line: \${d.line + 1}\` : ''}
            \`)
            .style('left', (event.pageX + 10) + 'px')
            .style('top', (event.pageY - 10) + 'px')
            .style('opacity', 1);
        }
        
        function hideTooltip() {
            d3.select('#tooltip').style('opacity', 0);
        }
        
        function resetZoom() {
            const rect = d3.select('#graph-container').node().getBoundingClientRect();
            svg.transition().duration(750).call(
                d3.zoom().transform,
                d3.zoomIdentity.translate(rect.width / 2, rect.height / 2).scale(1)
            );
        }
        
        function toggleLabels() {
            showLabels = !showLabels;
            if (labelElements) {
                labelElements.style('display', showLabels ? 'block' : 'none');
            }
        }
        
        function highlightFile(filePath) {
            if (nodeElements) {
                nodeElements.selectAll('rect, circle, polygon')
                    .classed('highlighted', d => d.filePath === filePath);
            }
        }
        
        // Message handler
        window.addEventListener('message', event => {
            const message = event.data;
            switch (message.command) {
                case 'updateGraph':
                    updateGraph(message.data);
                    break;
                case 'highlightFile':
                    highlightFile(message.filePath);
                    break;
            }
        });
        
        // Initialize when DOM is ready
        document.addEventListener('DOMContentLoaded', () => {
            initGraph();
            vscode.postMessage({ command: 'ready' });
        });
        
        // Handle window resize
        window.addEventListener('resize', () => {
            const container = d3.select('#graph-container');
            const rect = container.node().getBoundingClientRect();
            svg.attr('width', rect.width).attr('height', rect.height);
            simulation.force('center', d3.forceCenter(rect.width / 2, rect.height / 2));
            simulation.alpha(0.3).restart();
        });
    </script>
</body>
</html>`;
    }

    dispose() {
        this.panel?.dispose();
    }
}