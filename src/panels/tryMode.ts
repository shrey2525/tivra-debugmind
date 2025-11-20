// Tivra Try Mode - Instant RCA from Error Logs
// Paste logs → Auto-detect → Scan workspace → RCA → Apply fix

import * as vscode from 'vscode';
import axios from 'axios';
import * as path from 'path';

interface ChatMessage {
  type: 'user' | 'ai' | 'system';
  content: string;
  timestamp: Date;
  suggestedPrompts?: string[];
  fix?: CodeFix;
}

interface CodeFix {
  file: string;
  line?: number;
  originalCode?: string;
  fixedCode?: string;
  newCode?: string;  // Alternative naming from backend
  explanation: string;
}

interface CodePath {
  file: string;
  line: number;
  context?: string;
}

interface RCAResult {
  rootCause: string;
  evidence: string[];
  suggestedActions: string[];
  codeFix?: CodeFix;
}

export class TryMode {
  public static currentPanel: TryMode | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _messages: ChatMessage[] = [];
  private _apiUrl: string;

  // RCA Flow state
  private _rcaState: {
    logs?: string;
    detectedPaths?: CodePath[];
    codeContext?: any[];
    rcaResult?: RCAResult;
  } = {};

  private constructor(
    panel: vscode.WebviewPanel,
    extensionUri: vscode.Uri,
    apiUrl: string
  ) {
    this._panel = panel;
    this._apiUrl = apiUrl;

    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview, extensionUri);

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      message => {
        switch (message.type) {
          case 'userMessage':
            this.handleUserMessage(message.text);
            break;
          case 'previewFix':
            this.previewFix(message.fix);
            break;
          case 'applyFix':
            this.applyFix(message.fix);
            break;
          case 'rejectFix':
            this.rejectFix();
            break;
        }
      },
      null,
      this._disposables
    );

    this._panel.onDidDispose(() => this.dispose(), null, this._disposables);

    // Show welcome message
    this.showWelcomeMessage();
  }

  public static createOrShow(
    extensionUri: vscode.Uri,
    apiUrl: string
  ) {
    const column = vscode.ViewColumn.Two;

    if (TryMode.currentPanel) {
      TryMode.currentPanel._panel.reveal(column);
      return TryMode.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'tivraTryMode',
      '🧪 Tivra Try Mode',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    TryMode.currentPanel = new TryMode(panel, extensionUri, apiUrl);
    return TryMode.currentPanel;
  }

  private showWelcomeMessage() {
    this.addMessage({
      type: 'ai',
      content: `**Welcome to Tivra Try Mode** 👋\n\n**Paste your error logs below to get instant RCA**\n\nI'll automatically:\n• Detect code paths in your logs\n• Scan your workspace for relevant code\n• Analyze the root cause\n• Suggest fixes you can apply with one click`,
      timestamp: new Date()
    });
  }

  private async handleUserMessage(text: string) {
    // Add user message
    this.addMessage({
      type: 'user',
      content: text,
      timestamp: new Date()
    });

    // Handle AWS connection prompts
    if (text.toLowerCase().includes('connect to aws') || text.toLowerCase().includes('connect aws')) {
      this.showAWSConnectionInfo();
      return;
    }

    if (text.toLowerCase().includes('how to connect') && text.toLowerCase().includes('aws')) {
      this.showAWSConnectionInfo();
      return;
    }

    // Handle Debug Copilot info request
    if (text.toLowerCase().includes('debug copilot') || text.toLowerCase().includes('what is debug')) {
      this.showDebugCopilotInfo();
      return;
    }

    // Check if user pasted more logs (terminal state)
    if (this._rcaState.rcaResult && this.detectLogPaste(text)) {
      // Reset state for new analysis
      this._rcaState = {};
      await this.handleLogPasteRCA(text);
      return;
    }

    // Check if user is pasting error logs for RCA
    const isLogPaste = this.detectLogPaste(text);
    if (isLogPaste) {
      await this.handleLogPasteRCA(text);
      return;
    }

    // Default response
    this.addMessage({
      type: 'ai',
      content: `I'm ready to analyze your error logs! Just paste them here and I'll:\n\n• Auto-detect code paths\n• Scan your workspace\n• Provide RCA and suggested fixes`,
      timestamp: new Date()
    });
  }

  private showAWSConnectionInfo() {
    this.addMessage({
      type: 'ai',
      content: `## 🔧 **How to Connect AWS**\n\n` +
        `To unlock the full investigation workflow with AWS integration:\n\n` +
        `**Step 1: Configure AWS Credentials**\n` +
        `\`\`\`bash\n` +
        `# Option A: AWS CLI (recommended)\n` +
        `aws configure\n\n` +
        `# Option B: Environment variables\n` +
        `export AWS_ACCESS_KEY_ID="your-key"\n` +
        `export AWS_SECRET_ACCESS_KEY="your-secret"\n` +
        `export AWS_REGION="us-east-1"\n` +
        `\`\`\`\n\n` +
        `**Step 2: Set Up Backend Server**\n` +
        `Make sure your Tivra backend server has AWS SDK configured.\n\n` +
        `**Step 3: Switch to Debug Copilot**\n` +
        `Use the **Debug Copilot** panel (not Try Mode) for full AWS integration.\n\n` +
        `**What You Get:**\n` +
        `• 📊 CloudWatch log analysis\n` +
        `• 🚀 Deployment tracking\n` +
        `• 🔄 Auto-rollback on failures\n` +
        `• 💾 Root cause database (Pinecone)\n` +
        `• ✅ Post-deployment verification\n` +
        `• 🤖 Autonomous monitoring\n\n` +
        `**Try Mode** is great for quick local fixes - **AWS Mode** handles production debugging!`,
      timestamp: new Date(),
      suggestedPrompts: ['Paste More Logs', 'What is Debug Copilot?']
    });
  }

  private showDebugCopilotInfo() {
    this.addMessage({
      type: 'ai',
      content: `## 🤖 **Debug Copilot vs Try Mode**\n\n` +
        `**Try Mode** (Current) - Quick Local Debugging:\n` +
        `• 📋 Paste error logs manually\n` +
        `• 🔍 Workspace code scanning\n` +
        `• 🎯 Root cause analysis\n` +
        `• ✨ One-click fix application\n` +
        `• ⚡ **No AWS connection needed**\n\n` +
        `**Debug Copilot** - Full Production Investigation:\n` +
        `• ☁️ **AWS CloudWatch integration**\n` +
        `• 📊 Real-time log streaming\n` +
        `• 🚀 Deployment history correlation\n` +
        `• 🔄 Auto-rollback capabilities\n` +
        `• 🎯 GitHub PR creation with fixes\n` +
        `• ✅ Post-deployment verification\n` +
        `• 🤖 Autonomous monitoring\n` +
        `• 💾 Root cause learning (Pinecone)\n\n` +
        `**When to Use Each:**\n` +
        `• **Try Mode**: Local development, quick fixes, no cloud access\n` +
        `• **Debug Copilot**: Production debugging, full workflow, team collaboration\n\n` +
        `To access Debug Copilot, open the Command Palette and search for "Tivra Debug Copilot".`,
      timestamp: new Date(),
      suggestedPrompts: ['Connect to AWS', 'Paste More Logs']
    });
  }

  private detectLogPaste(text: string): boolean {
    // Detect if text looks like error logs
    const logIndicators = [
      /error/i,
      /exception/i,
      /stack trace/i,
      /at\s+[\w.]+\([^)]+:\d+:\d+\)/,  // Stack trace pattern
      /at\s+[\w.]+\.[\w]+\s*\(/,  // Method call pattern
      /\w+Error:/,  // Error type pattern
      /Failed to/i,
      /Cannot/i,
      /\d{4}-\d{2}-\d{2}.*ERROR/,  // Log timestamp with ERROR
      /src\/[\w/]+\.[\w]+:\d+/,  // File path with line number
    ];

    const hasMultipleLines = text.split('\n').length > 2;
    const hasLogIndicator = logIndicators.some(pattern => pattern.test(text));

    return hasMultipleLines && hasLogIndicator;
  }

  private async handleLogPasteRCA(logs: string) {
    this._rcaState.logs = logs;

    // Step 1: Show auto-scan message
    this.addMessage({
      type: 'system',
      content: `🔍 Auto-scanning logs for code paths...`,
      timestamp: new Date()
    });

    // Step 2: Detect code paths
    const detectedPaths = this.detectCodePaths(logs);
    this._rcaState.detectedPaths = detectedPaths;

    if (detectedPaths.length === 0) {
      this.addMessage({
        type: 'ai',
        content: `⚠️ **No code paths detected**\n\nI couldn't find specific file paths in your logs. I'll still analyze the error, but results may be limited.\n\nProceeding with RCA...`,
        timestamp: new Date()
      });

      // Continue with RCA even without code paths
      await this.performBackendRCA(logs, []);
      return;
    }

    // Show detected paths
    const pathsList = detectedPaths.map(p => `• \`${p.file}:${p.line}\``).join('\n');
    this.addMessage({
      type: 'ai',
      content: `✅ **Detected code paths:**\n\n${pathsList}\n\nScanning workspace...`,
      timestamp: new Date()
    });

    // Step 3: Scan workspace for code context
    this.addMessage({
      type: 'system',
      content: `📂 Scanning workspace for relevant code...`,
      timestamp: new Date()
    });

    const codeContext = await this.scanWorkspace(detectedPaths);
    this._rcaState.codeContext = codeContext;

    if (codeContext.length === 0) {
      this.addMessage({
        type: 'ai',
        content: `⚠️ **Files not found in workspace**\n\nCouldn't locate the files mentioned in the logs. Proceeding with log-only analysis...`,
        timestamp: new Date()
      });
    } else {
      this.addMessage({
        type: 'ai',
        content: `✅ **Found ${codeContext.length} file(s)** in workspace\n\nAnalyzing with Claude...`,
        timestamp: new Date()
      });
    }

    // Step 4: Send to backend for RCA
    await this.performBackendRCA(logs, codeContext);
  }

  private detectCodePaths(logs: string): CodePath[] {
    const paths: CodePath[] = [];
    const lines = logs.split('\n');

    // Patterns to detect file paths with line numbers
    const patterns = [
      // Pattern: at src/app.ts:45:12
      /at\s+([\w/.\\-]+\.(ts|js|tsx|jsx|py|java|go|rb)):(\d+)/g,
      // Pattern: src/app.ts:45
      /([\w/.\\-]+\.(ts|js|tsx|jsx|py|java|go|rb)):(\d+)/g,
      // Pattern: File "src/app.ts", line 45
      /File\s+"([\w/.\\-]+\.(ts|js|tsx|jsx|py|java|go|rb))",\s+line\s+(\d+)/g,
      // Pattern: /full/path/to/src/app.ts:45
      /([/\\][\w/.\\-]+\.(ts|js|tsx|jsx|py|java|go|rb)):(\d+)/g,
    ];

    for (const line of lines) {
      for (const pattern of patterns) {
        let match;
        while ((match = pattern.exec(line)) !== null) {
          const file = match[1];
          const lineNum = parseInt(match[3] || match[2], 10);

          // Avoid duplicates
          if (!paths.some(p => p.file === file && p.line === lineNum)) {
            paths.push({
              file,
              line: lineNum,
              context: line.trim()
            });
          }
        }
      }
    }

    return paths;
  }

  private async scanWorkspace(codePaths: CodePath[]): Promise<any[]> {
    const codeContext: any[] = [];
    const workspaceFolders = vscode.workspace.workspaceFolders;

    if (!workspaceFolders || workspaceFolders.length === 0) {
      return [];
    }

    const workspaceRoot = workspaceFolders[0].uri.fsPath;

    for (const codePath of codePaths) {
      try {
        // Try to find the file in workspace
        let filePath = codePath.file;

        // If it's a relative path, join with workspace root
        if (!path.isAbsolute(filePath)) {
          filePath = path.join(workspaceRoot, filePath);
        }

        // Check if file exists
        const fileUri = vscode.Uri.file(filePath);
        const document = await vscode.workspace.openTextDocument(fileUri);

        // Get context around the line (10 lines before and after)
        const lineNum = codePath.line - 1; // VS Code uses 0-based indexing
        const startLine = Math.max(0, lineNum - 10);
        const endLine = Math.min(document.lineCount - 1, lineNum + 10);

        let codeSnippet = '';
        for (let i = startLine; i <= endLine; i++) {
          const lineText = document.lineAt(i).text;
          const lineMarker = i === lineNum ? '>>>' : '   ';
          codeSnippet += `${lineMarker} ${i + 1}: ${lineText}\n`;
        }

        codeContext.push({
          file: codePath.file,
          line: codePath.line,
          code: codeSnippet,
          fullPath: filePath
        });
      } catch (error) {
        console.error(`Failed to read file ${codePath.file}:`, error);
        // Continue with other files
      }
    }

    return codeContext;
  }

  private async performBackendRCA(logs: string, codeContext: any[]) {
    this.addMessage({
      type: 'system',
      content: `🤖 Analyzing with Claude AI...`,
      timestamp: new Date()
    });

    try {
      // Transform codeContext to match backend expectations
      const code_context = {
        files: codeContext.map(ctx => ({
          file_path: ctx.file,
          content: ctx.code || '',
          line_number: ctx.line,
          language: this.detectLanguage(ctx.file),
          fullPath: ctx.fullPath
        }))
      };

      const response = await axios.post(`${this._apiUrl}/api/try-mode/analyze`, {
        logs,
        code_context,
        service_name: 'workspace-service'
      });

      // Transform backend response to RCAResult format
      const backendData = response.data;
      const rcaResult: RCAResult = {
        rootCause: backendData.root_cause || 'Unknown',
        evidence: backendData.evidence || [],
        suggestedActions: backendData.suggested_actions || [],
        codeFix: backendData.fix_code && backendData.fix_file ? {
          file: backendData.fix_file,
          line: backendData.line_number,
          fixedCode: backendData.fix_code,
          newCode: backendData.fix_code,
          explanation: backendData.suggested_fix || 'Code fix generated'
        } : undefined
      };

      this._rcaState.rcaResult = rcaResult;

      // Display RCA results
      this.displayRCAResults(rcaResult);
    } catch (error: any) {
      console.error('RCA analysis error:', error);
      this.addMessage({
        type: 'ai',
        content: `❌ **Analysis Failed**\n\nError: ${error.response?.data?.error || error.message}\n\nPlease make sure the backend server is running and try again.`,
        timestamp: new Date(),
        suggestedPrompts: ['Paste More Logs']
      });
    }
  }

  private detectLanguage(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();
    const langMap: { [key: string]: string } = {
      '.js': 'javascript',
      '.ts': 'typescript',
      '.jsx': 'javascript',
      '.tsx': 'typescript',
      '.py': 'python',
      '.java': 'java',
      '.go': 'go',
      '.rb': 'ruby',
      '.php': 'php',
      '.cs': 'csharp'
    };
    return langMap[ext] || 'text';
  }

  private displayRCAResults(rca: RCAResult) {
    // Build the results message
    let content = `**🎯 Root Cause Analysis Complete**\n\n`;

    content += `**Root Cause:**\n${rca.rootCause}\n\n`;

    if (rca.evidence && rca.evidence.length > 0) {
      content += `**Evidence:**\n`;
      rca.evidence.forEach(e => content += `• ${e}\n`);
      content += `\n`;
    }

    if (rca.suggestedActions && rca.suggestedActions.length > 0) {
      content += `**Suggested Actions:**\n`;
      rca.suggestedActions.forEach(a => content += `• ${a}\n`);
      content += `\n`;
    }

    if (rca.codeFix) {
      content += `**💡 Code Fix Available**\n\n`;
      content += `File: \`${rca.codeFix.file}:${rca.codeFix.line || '?'}\`\n\n`;
      content += `**Explanation:** ${rca.codeFix.explanation}\n\n`;

      const displayCode = rca.codeFix.fixedCode || rca.codeFix.newCode || '';
      if (displayCode) {
        content += `\`\`\`\n${displayCode.substring(0, 500)}${displayCode.length > 500 ? '\n... (truncated for display)' : ''}\n\`\`\`\n\n`;
      }

      content += `Click **Preview Fix** to see a side-by-side diff before applying.`;

      this.addMessage({
        type: 'ai',
        content,
        timestamp: new Date(),
        fix: rca.codeFix,
        suggestedPrompts: ['Preview Fix', 'Paste More Logs']
      });
    } else {
      this.addMessage({
        type: 'ai',
        content,
        timestamp: new Date(),
        suggestedPrompts: ['Paste More Logs']
      });
    }
  }

  private async previewFix(fix: CodeFix) {
    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        vscode.window.showErrorMessage('No workspace folder open');
        return;
      }

      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      let filePath = fix.file;

      if (!path.isAbsolute(filePath)) {
        filePath = path.join(workspaceRoot, filePath);
      }

      const fileUri = vscode.Uri.file(filePath);

      // Read the current file content
      const document = await vscode.workspace.openTextDocument(fileUri);
      const originalContent = document.getText();

      // Create a temporary file with the fixed content
      const fixedContent = fix.fixedCode || fix.newCode || '';

      // Use VSCode's diff editor to show the preview
      const originalUri = fileUri;
      const modifiedUri = fileUri.with({
        scheme: 'untitled',
        path: `${filePath}.fixed`
      });

      // Create temporary document with fixed content
      const tempDocument = await vscode.workspace.openTextDocument(
        modifiedUri.with({ scheme: 'untitled' })
      );

      const edit = new vscode.WorkspaceEdit();
      edit.insert(tempDocument.uri, new vscode.Position(0, 0), fixedContent);
      await vscode.workspace.applyEdit(edit);

      // Open diff editor
      await vscode.commands.executeCommand(
        'vscode.diff',
        originalUri,
        tempDocument.uri,
        `${path.basename(fix.file)}: Original ↔ Fixed`,
        { preview: true }
      );

      // Show notification with actions
      const action = await vscode.window.showInformationMessage(
        `Preview fix for ${fix.file}`,
        { modal: false },
        'Apply Fix',
        'Cancel'
      );

      if (action === 'Apply Fix') {
        // Apply the fix
        await this.applyFixContent(fix, document, fixedContent);
      } else {
        // User cancelled
        this.addMessage({
          type: 'system',
          content: '❌ Fix preview cancelled.',
          timestamp: new Date()
        });
      }

      // Close the temporary document
      await vscode.commands.executeCommand('workbench.action.closeActiveEditor');

    } catch (error: any) {
      console.error('Preview fix error:', error);
      vscode.window.showErrorMessage(`Failed to preview fix: ${error.message}`);
    }
  }

  private rejectFix() {
    this.addMessage({
      type: 'system',
      content: '❌ Fix rejected.',
      timestamp: new Date(),
      suggestedPrompts: ['Paste More Logs', 'Analyze Different Error']
    });
  }

  private async applyFixContent(fix: CodeFix, document: vscode.TextDocument, fixedContent: string) {
    try {
      const fileUri = document.uri;
      const edit = new vscode.WorkspaceEdit();

      // Replace entire file content
      const fullRange = new vscode.Range(
        document.positionAt(0),
        document.positionAt(document.getText().length)
      );

      edit.replace(fileUri, fullRange, fixedContent);
      await vscode.workspace.applyEdit(edit);
      await document.save();

      this.addMessage({
        type: 'ai',
        content: `✅ **Fix Applied Successfully!**\n\nFile: \`${fix.file}\`\n\nThe fix has been applied and saved.`,
        timestamp: new Date()
      });

      // Show success notification
      vscode.window.showInformationMessage(`✅ Fix applied to ${fix.file}`);

      // Add terminal state message prompting AWS connection
      setTimeout(() => {
        this.addMessage({
          type: 'ai',
          content: `## 🚀 **Want to Verify Your Fix?**\n\n` +
            `**Connect to AWS** for complete post-deployment verification:\n\n` +
            `✅ **Deployment History** - Track when and how this was deployed\n` +
            `✅ **Live Error Monitoring** - Verify the fix resolved the issue\n` +
            `✅ **Auto-Rollback** - Automatic rollback if errors persist\n` +
            `✅ **Production Metrics** - See real-time impact on your service\n` +
            `✅ **Root Cause Tracking** - Store learnings for future debugging\n\n` +
            `**Try Mode** gave you a quick fix - but **AWS Mode** ensures it works in production!\n\n` +
            `Connect your AWS account to unlock the full investigation workflow.`,
          timestamp: new Date(),
          suggestedPrompts: ['Connect to AWS', 'Paste More Logs', 'How to Connect AWS?']
        });
      }, 1500); // Delay to let success message be seen first

    } catch (error: any) {
      console.error('Apply fix error:', error);
      this.addMessage({
        type: 'ai',
        content: `❌ **Failed to Apply Fix**\n\nError: ${error.message}`,
        timestamp: new Date()
      });
      vscode.window.showErrorMessage(`Failed to apply fix: ${error.message}`);
    }
  }

  private async applyFix(fix: CodeFix) {
    this.addMessage({
      type: 'system',
      content: `🔧 Applying fix to ${fix.file}...`,
      timestamp: new Date()
    });

    try {
      const workspaceFolders = vscode.workspace.workspaceFolders;
      if (!workspaceFolders || workspaceFolders.length === 0) {
        throw new Error('No workspace folder open');
      }

      const workspaceRoot = workspaceFolders[0].uri.fsPath;
      let filePath = fix.file;

      if (!path.isAbsolute(filePath)) {
        filePath = path.join(workspaceRoot, filePath);
      }

      const fileUri = vscode.Uri.file(filePath);
      const document = await vscode.workspace.openTextDocument(fileUri);

      // If we have the complete fixed code, use the applyFixContent method
      const fixedContent = fix.fixedCode || fix.newCode;

      if (fixedContent) {
        await this.applyFixContent(fix, document, fixedContent);
      } else if (fix.originalCode) {
        // Fallback: Find and replace the original code snippet
        const text = document.getText();
        const originalCode = fix.originalCode.trim();

        if (text.includes(originalCode)) {
          const edit = new vscode.WorkspaceEdit();
          const fullText = document.getText();
          const startPos = document.positionAt(fullText.indexOf(originalCode));
          const endPos = document.positionAt(fullText.indexOf(originalCode) + originalCode.length);
          const range = new vscode.Range(startPos, endPos);

          edit.replace(fileUri, range, fix.fixedCode || '');
          await vscode.workspace.applyEdit(edit);
          await document.save();

          // Open the file to show the fix
          await vscode.window.showTextDocument(document, {
            selection: new vscode.Range(startPos, endPos),
            viewColumn: vscode.ViewColumn.One
          });

          this.addMessage({
            type: 'ai',
            content: `✅ **Fix Applied Successfully!**\n\nFile: \`${fix.file}:${fix.line || '?'}\`\n\nThe fix has been applied and saved. Review the changes in the editor.`,
            timestamp: new Date(),
            suggestedPrompts: ['Paste More Logs']
          });
        } else {
          throw new Error('Original code not found in file. The file may have been modified.');
        }
      } else {
        throw new Error('No fix code provided');
      }
    } catch (error: any) {
      console.error('Apply fix error:', error);
      this.addMessage({
        type: 'ai',
        content: `❌ **Failed to Apply Fix**\n\nError: ${error.message}\n\nYou may need to apply the fix manually.`,
        timestamp: new Date(),
        suggestedPrompts: ['Paste More Logs']
      });
    }
  }

  private addMessage(message: ChatMessage) {
    this._messages.push(message);
    this._panel.webview.postMessage({
      type: 'addMessage',
      message: {
        ...message,
        timestamp: message.timestamp.toISOString()
      }
    });
  }

  private _getHtmlForWebview(webview: vscode.Webview, extensionUri: vscode.Uri) {
    const logoPath = vscode.Uri.joinPath(extensionUri, 'media', 'logo.png');
    const logoUri = webview.asWebviewUri(logoPath);

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Tivra Try Mode</title>
  <style>
    * { margin: 0; padding: 0; box-sizing: border-box; }

    body {
      font-family: var(--vscode-font-family);
      color: var(--vscode-foreground);
      background-color: var(--vscode-editor-background);
      height: 100vh;
      display: flex;
      flex-direction: column;
    }

    .header {
      padding: 16px;
      background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
      color: white;
      display: flex;
      align-items: center;
      gap: 12px;
    }

    .logo {
      width: 32px;
      height: 32px;
      border-radius: 4px;
    }

    .header h2 {
      font-size: 16px;
      font-weight: 600;
    }

    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 20px;
      display: flex;
      flex-direction: column;
      gap: 16px;
    }

    .message {
      padding: 14px 16px;
      border-radius: 12px;
      max-width: 85%;
      animation: slideIn 0.3s ease-out;
      box-shadow: 0 2px 8px rgba(0,0,0,0.1);
    }

    @keyframes slideIn {
      from { opacity: 0; transform: translateY(10px); }
      to { opacity: 1; transform: translateY(0); }
    }

    .message.user {
      background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
      color: white;
      align-self: flex-end;
    }

    .message.ai {
      background-color: var(--vscode-editor-selectionBackground);
      align-self: flex-start;
      border-left: 3px solid #8b5cf6;
    }

    .message.system {
      background-color: var(--vscode-inputValidation-infoBackground);
      align-self: center;
      font-size: 13px;
      text-align: center;
      max-width: 60%;
      border-radius: 20px;
    }

    .message-content {
      line-height: 1.6;
      font-size: 14px;
    }

    .message-content h2 { font-size: 16px; margin: 12px 0 8px; }
    .message-content h3 { font-size: 14px; margin: 10px 0 6px; }
    .message-content strong { font-weight: 600; }
    .message-content code {
      background-color: rgba(0,0,0,0.2);
      padding: 2px 6px;
      border-radius: 4px;
      font-size: 13px;
    }

    .message-content pre {
      background-color: var(--vscode-textBlockQuote-background);
      padding: 12px;
      border-radius: 6px;
      overflow-x: auto;
      margin: 10px 0;
    }

    .suggested-prompts {
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .prompt-button {
      padding: 10px 14px;
      background: rgba(139, 92, 246, 0.1);
      color: var(--vscode-foreground);
      border: 1px solid rgba(139, 92, 246, 0.3);
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      text-align: left;
      transition: all 0.2s;
    }

    .prompt-button:hover {
      background: rgba(139, 92, 246, 0.2);
      border-color: rgba(139, 92, 246, 0.5);
      transform: translateX(4px);
    }

    .input-container {
      padding: 16px;
      background-color: var(--vscode-editor-background);
      border-top: 1px solid var(--vscode-panel-border);
      display: flex;
      gap: 10px;
    }

    #userInput {
      flex: 1;
      padding: 12px;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 8px;
      font-size: 14px;
      resize: vertical;
      min-height: 50px;
      max-height: 200px;
      font-family: var(--vscode-font-family);
    }

    #sendButton {
      padding: 12px 24px;
      background: linear-gradient(135deg, #8b5cf6 0%, #6d28d9 100%);
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
      transition: transform 0.2s;
    }

    #sendButton:hover {
      transform: scale(1.05);
    }

    #sendButton:disabled {
      opacity: 0.5;
      cursor: not-allowed;
    }
  </style>
</head>
<body>
  <div class="header">
    <img src="${logoUri}" alt="Tivra Logo" class="logo">
    <h2>🧪 Tivra Try Mode - Instant RCA</h2>
  </div>

  <div class="messages" id="messages"></div>

  <div class="input-container">
    <textarea
      id="userInput"
      placeholder="Paste your error logs here or ask me anything..."
      rows="3"
    ></textarea>
    <button id="sendButton">Send</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesDiv = document.getElementById('messages');
    const userInput = document.getElementById('userInput');
    const sendButton = document.getElementById('sendButton');

    function sendMessage() {
      const text = userInput.value.trim();
      if (!text) return;

      vscode.postMessage({
        type: 'userMessage',
        text: text
      });

      userInput.value = '';
      userInput.style.height = '50px';
    }

    sendButton.addEventListener('click', sendMessage);

    userInput.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
    });

    // Auto-resize textarea
    userInput.addEventListener('input', () => {
      userInput.style.height = '50px';
      userInput.style.height = Math.min(userInput.scrollHeight, 200) + 'px';
    });

    function addMessage(message) {
      const messageDiv = document.createElement('div');
      messageDiv.className = \`message \${message.type}\`;

      let content = marked.parse(message.content);
      messageDiv.innerHTML = \`<div class="message-content">\${content}</div>\`;

      if (message.suggestedPrompts && message.suggestedPrompts.length > 0) {
        const promptsDiv = document.createElement('div');
        promptsDiv.className = 'suggested-prompts';

        message.suggestedPrompts.forEach(prompt => {
          const button = document.createElement('button');
          button.className = 'prompt-button';
          button.textContent = prompt;
          button.addEventListener('click', () => {
            if (prompt === 'Preview Fix' && message.fix) {
              vscode.postMessage({
                type: 'previewFix',
                fix: message.fix
              });
            } else if (prompt === 'Apply Fix' && message.fix) {
              vscode.postMessage({
                type: 'applyFix',
                fix: message.fix
              });
            } else {
              userInput.value = prompt;
              userInput.focus();
            }
          });
          promptsDiv.appendChild(button);
        });

        messageDiv.appendChild(promptsDiv);
      }

      messagesDiv.appendChild(messageDiv);
      messagesDiv.scrollTop = messagesDiv.scrollHeight;
    }

    // Listen for messages from extension
    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'addMessage') {
        addMessage(message.message);
      }
    });

    // Simple markdown parser
    const marked = {
      parse: (text) => {
        return text
          .replace(/\*\*(.*?)\*\*/g, '<strong>$1</strong>')
          .replace(/\*(.*?)\*/g, '<em>$1</em>')
          .replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre>$1</pre>')
          .replace(/\`(.*?)\`/g, '<code>$1</code>')
          .replace(/^### (.*$)/gim, '<h3>$1</h3>')
          .replace(/^## (.*$)/gim, '<h2>$1</h2>')
          .replace(/^# (.*$)/gim, '<h1>$1</h1>')
          .replace(/\\n/g, '<br>');
      }
    };
  </script>
</body>
</html>`;
  }

  public dispose() {
    TryMode.currentPanel = undefined;

    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) {
        disposable.dispose();
      }
    }
  }
}
