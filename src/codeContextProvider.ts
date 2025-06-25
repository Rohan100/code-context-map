import * as vscode from 'vscode';
import * as path from 'path';
import { CodeAnalyzer } from './codeAnalyzer';
import { GraphData, GraphNode, GraphEdge } from './types';

export class CodeContextProvider implements vscode.Disposable {
    private panel?: vscode.WebviewPanel;
    private analyzer: CodeAnalyzer;
    private currentGraphData?: GraphData;
    private currentActiveFile?: string;

    constructor(private readonly extensionUri: vscode.Uri) {
        this.analyzer = new CodeAnalyzer();
    }

    public async showCodeMap() {
        // Check if we have an active file
        const activeEditor = vscode.window.activeTextEditor;
        
        if (!activeEditor) {
            vscode.window.showErrorMessage(
                'Please open a TypeScript/JavaScript file to use Code Context Navigator'
            );
            return;
        }

        // Check if it's a supported file type
        const filePath = activeEditor.document.uri.fsPath;
        if (!/\.(ts|tsx|js|jsx)$/.test(filePath) || filePath.endsWith('.d.ts')) {
            vscode.window.showErrorMessage(
                'Code Context Navigator only supports TypeScript and JavaScript files'
            );
            return;
        }

        if (this.panel) {
            this.panel.reveal(vscode.ViewColumn.Beside);
            // If different file is active, refresh the map
            if (this.currentActiveFile !== filePath) {
                await this.refreshMapForActiveFile();
            }
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
                        await this.refreshMapForActiveFile();
                        break;
                    case 'refreshForActiveFile':
                        await this.refreshMapForActiveFile();
                        break;
                }
            }
        );

        this.panel.onDidDispose(() => {
            this.panel = undefined;
            this.currentActiveFile = undefined;
        });
    }

    public async refreshMapForActiveFile() {
        if (!this.panel) {
            return;
        }

        const activeEditor = vscode.window.activeTextEditor;
        if (!activeEditor) {
            vscode.window.showErrorMessage('No active file to analyze');
            return;
        }

        const activeFilePath = activeEditor.document.uri.fsPath;
        
        // Check if it's a supported file type
        if (!/\.(ts|tsx|js|jsx)$/.test(activeFilePath) || activeFilePath.endsWith('.d.ts')) {
            this.panel.webview.postMessage({
                command: 'showMessage',
                message: 'Please switch to a TypeScript or JavaScript file'
            });
            return;
        }

        this.currentActiveFile = activeFilePath;

        try {
            const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
            const workspacePath = workspaceFolder ? workspaceFolder.uri.fsPath : undefined;
            
            vscode.window.showInformationMessage(
                `Analyzing function calls from: ${path.basename(activeFilePath)}`
            );

            this.currentGraphData = await this.analyzer.analyzeActiveFile(activeFilePath, workspacePath);
            
            this.panel.webview.postMessage({
                command: 'updateGraph',
                data: this.currentGraphData,
                activeFile: activeFilePath
            });

            console.log('Active file analysis complete:', this.currentGraphData);
            
            const functionCount = this.currentGraphData.nodes.filter(n => n.type === 'function').length;
            const callCount = this.currentGraphData.edges.filter(e => e.type === 'calls').length;
            
            vscode.window.showInformationMessage(
                `Found ${functionCount} functions with ${callCount} function calls`
            );

        } catch (error) {
            console.error('Error analyzing active file:', error);
            vscode.window.showErrorMessage('Error analyzing active file: ' + error);
        }
    }

    // Legacy method for backward compatibility
    public async refreshMap() {
        await this.refreshMapForActiveFile();
    }

    public async onActiveEditorChanged(editor?: vscode.TextEditor) {
        if (!this.panel || !editor) {
            return;
        }

        const filePath = editor.document.uri.fsPath;
        
        // Only refresh if it's a different supported file
        if (this.currentActiveFile !== filePath && 
            /\.(ts|tsx|js|jsx)$/.test(filePath) && 
            !filePath.endsWith('.d.ts')) {
            
            await this.refreshMapForActiveFile();
        }

        // Highlight the current file in the graph
        this.panel.webview.postMessage({
            command: 'highlightFile',
            filePath: filePath
        });
    }

    public async onFileChanged(uri: vscode.Uri) {
        if (!this.panel || !this.currentGraphData) {
            return;
        }

        const changedFilePath = uri.fsPath;

        // If the changed file is the active file or affects the current graph, refresh
        if (this.currentActiveFile === changedFilePath || 
            this.currentGraphData.nodes.some(node => node.filePath === changedFilePath)) {
            
            await this.refreshMapForActiveFile();
        }
    }

    public onFileDeleted(uri: vscode.Uri) {
        if (!this.panel || !this.currentGraphData) {
            return;
        }

        const deletedFilePath = uri.fsPath;

        // If the deleted file was part of the current graph, refresh
        if (this.currentGraphData.nodes.some(node => node.filePath === deletedFilePath)) {
            this.refreshMapForActiveFile();
        }
    }

    private async navigateToNode(nodeId: string) {
        if (!this.currentGraphData) {
            return;
        }

        const node = this.currentGraphData.nodes.find(n => n.id === nodeId);
        if (!node || node.filePath === 'unknown') {
            if (node?.filePath === 'unknown') {
                vscode.window.showWarningMessage(
                    `Function "${node.name}" might be from an external library or not found in the workspace`
                );
            }
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
        if (!node || node.filePath === 'unknown') {
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
            console.log('Updating graph with data:', data);
            
            // Validate input data
            if (!data || !data.nodes || !data.edges) {
                console.error('Invalid graph data:', data);
                return;
            }
            
            graphData = data;
            
            // Process nodes - create a proper node object with required properties
            nodes = data.nodes.map((node, index) => {
                if (!node || !node.id) {
                    console.error('Invalid node at index', index, ':', node);
                    return null;
                }
                
                return {
                    ...node,
                    // Ensure we have all required properties for D3 simulation
                    x: node.x || Math.random() * 800,
                    y: node.y || Math.random() * 600,
                    vx: 0, // Initialize velocity
                    vy: 0,
                    fx: null, // Fixed positions
                    fy: null
                };
            }).filter(node => node !== null);
            
            console.log('Valid nodes after processing:', nodes.length);
            console.log('Node IDs:', nodes.map(n => n.id));
            
            // Create a map for quick node lookup
            const nodeMap = new Map(nodes.map(node => [node.id, node]));
            
            // Process links - ensure source and target reference actual node objects
            links = data.edges.map((edge, index) => {
                if (!edge || !edge.source || !edge.target) {
                    console.error('Invalid edge at index', index, ':', edge);
                    return null;
                }
                
                const sourceNode = nodeMap.get(edge.source);
                const targetNode = nodeMap.get(edge.target);
                
                if (!sourceNode) {
                    console.warn('Missing source node for edge:', edge.source, 'Available nodes:', Array.from(nodeMap.keys()));
                    return null;
                }
                
                if (!targetNode) {
                    console.warn('Missing target node for edge:', edge.target, 'Available nodes:', Array.from(nodeMap.keys()));
                    return null;
                }
                
                return {
                    source: sourceNode.id, // Use ID string initially, D3 will convert to object
                    target: targetNode.id, // Use ID string initially, D3 will convert to object
                    type: edge.type,
                    // Store original IDs for reference
                    sourceId: edge.source,
                    targetId: edge.target
                };
            }).filter(link => link !== null);
            
            console.log('Valid links after processing:', links.length);
            console.log('Links:', links.map(l => \`\${l.source} -> \${l.target}\`));
            
            // Stop any existing simulation
            if (simulation) {
                simulation.stop();
            }
            
            // Update the visualization
            updateVisualization();
        }
        
        function updateVisualization() {
            const graphGroup = svg.select('.graph-group');
            
            // Clear existing elements to prevent duplication
            graphGroup.selectAll('*').remove();
            
            // Recreate simulation with current data
            simulation = d3.forceSimulation(nodes)
                .force('link', d3.forceLink(links)
                    .id(d => d.id)
                    .distance(100)
                )
                .force('charge', d3.forceManyBody().strength(-300))
                .force('center', d3.forceCenter(svg.attr('width') / 2, svg.attr('height') / 2))
                .force('collision', d3.forceCollide().radius(30));
            
            // Create links
            linkElements = graphGroup.selectAll('.link')
                .data(links)
                .enter()
                .append('line')
                .attr('class', 'link');
            
            // Create node groups
            const nodeGroups = graphGroup.selectAll('.node-group')
                .data(nodes)
                .enter()
                .append('g')
                .attr('class', 'node-group')
                .call(d3.drag()
                    .on('start', dragstarted)
                    .on('drag', dragged)
                    .on('end', dragended));
            
            // Add shapes based on node type
            nodeGroups.each(function(d) {
                const group = d3.select(this);
                
                if (d.type === 'file') {
                    group.append('rect')
                        .attr('width', 20)
                        .attr('height', 15)
                        .attr('x', -10)
                        .attr('y', -7.5)
                        .attr('class', \`node \${d.type}\`);
                } else if (d.type === 'class') {
                    group.append('polygon')
                        .attr('points', '0,-12 12,0 0,12 -12,0')
                        .attr('class', \`node \${d.type}\`);
                } else {
                    group.append('circle')
                        .attr('r', 8)
                        .attr('class', \`node \${d.type}\`);
                }
            });
            
            nodeElements = nodeGroups;
            
            // Add event handlers to shapes
            nodeElements.selectAll('rect, circle, polygon')
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
            
            // Create labels
            labelElements = graphGroup.selectAll('.node-label')
                .data(nodes)
                .enter()
                .append('text')
                .attr('class', 'node-label')
                .text(d => d.name)
                .style('display', showLabels ? 'block' : 'none');
            
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
            
            console.log('Visualization updated successfully');
        }
        
        // Drag functions
        function dragstarted(event, d) {
            if (!event.active) simulation.alphaTarget(0.3).restart();
            d.fx = d.x;
            d.fy = d.y;
        }
        
        function dragged(event, d) {
            d.fx = event.x;
            d.fy = event.y;
        }
        
        function dragended(event, d) {
            if (!event.active) simulation.alphaTarget(0);
            d.fx = null;
            d.fy = null;
        }
        
        function showTooltip(event, d) {
            const tooltip = d3.select('#tooltip');
            tooltip.html(\`
                <strong>\${d.name}</strong><br/>
                Type: \${d.type}<br/>
                File: \${d.filePath.split('/').pop() || d.filePath.split('\\\\').pop()}<br/>
                \${d.line !== undefined ? \`Line: \${d.line + 1}\` : ''}
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