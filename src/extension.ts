// Tivra DebugMind - Simplified v1.0
// Focus: Logs + AI Copilot Chat

import * as vscode from 'vscode';
import { DebugCopilot } from './panels/debugCopilot';
import { CredentialManager } from './utils/credential-manager';
import { AnalyticsTracker } from './analytics/analytics-tracker';

let copilot: DebugCopilot | undefined;
let statusBarItem: vscode.StatusBarItem;
let apiUrl: string;
let credentialManager: CredentialManager;
let analytics: AnalyticsTracker | undefined;

export async function activate(context: vscode.ExtensionContext) {
  console.log('🤖 Tivra DebugMind activated!');

  // Initialize Analytics Tracker with GA4
  analytics = new AnalyticsTracker(context);
  context.subscriptions.push({
    dispose: () => analytics?.dispose()
  });
  console.log('[Tivra DebugMind] Analytics initialized');

  // Initialize Credential Manager with VS Code SecretStorage
  credentialManager = new CredentialManager(context.secrets);
  console.log('[Tivra DebugMind] Credential Manager initialized');

  // Get API URL from config
  // Production: https://copilot.tivra.ai | Local Dev: http://localhost:3001
  apiUrl = vscode.workspace.getConfiguration('tivra').get<string>('apiUrl') || 'https://copilot.tivra.ai';
  console.log(`[Tivra DebugMind] API URL: ${apiUrl}`);

  // Create status bar
  statusBarItem = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 100);
  statusBarItem.text = '$(bug) DebugMind';
  statusBarItem.command = 'tivra.openCopilot';
  statusBarItem.tooltip = 'Open Tivra DebugMind';
  statusBarItem.show();
  context.subscriptions.push(statusBarItem);

  // Command: Open Debug Copilot
  context.subscriptions.push(
    vscode.commands.registerCommand('tivra.openCopilot', async () => {
      analytics?.trackFunnelStep('copilot_opened');
      analytics?.trackFeatureUsage('copilot', 'open');

      copilot = DebugCopilot.createOrShow(context.extensionUri, context, apiUrl, credentialManager, analytics);
    })
  );

  // Command: Start Debugging (with service selection)
  context.subscriptions.push(
    vscode.commands.registerCommand('tivra.startDebugging', async () => {
      analytics?.trackFeatureUsage('debugging', 'start');
      await startDebugging(context);
    })
  );

  // Command: Connect to AWS
  context.subscriptions.push(
    vscode.commands.registerCommand('tivra.connectAWS', async () => {
      analytics?.trackFunnelStep('aws_connection_started');
      analytics?.trackFeatureUsage('aws', 'connect_start');
      await connectToAWS();
    })
  );

  // Show welcome message on first activation
  const hasShownWelcome = context.globalState.get('hasShownWelcome');
  if (!hasShownWelcome) {
    analytics?.trackFunnelStep('welcome_shown');
    showWelcomeMessage(context);
    context.globalState.update('hasShownWelcome', true);
  }
}

async function startDebugging(context: vscode.ExtensionContext) {
  // Open copilot if not already open
  if (!copilot) {
    copilot = DebugCopilot.createOrShow(context.extensionUri, context, apiUrl, credentialManager, analytics);
  }

  // Ask user to select service
  const serviceName = await vscode.window.showInputBox({
    prompt: 'Enter AWS service name (e.g., payment-processor)',
    placeHolder: 'payment-processor',
    validateInput: (value) => {
      return value.trim() ? null : 'Service name cannot be empty';
    }
  });

  if (!serviceName) {
    return;
  }

  const serviceType = await vscode.window.showQuickPick(
    ['Lambda', 'ECS', 'RDS'],
    {
      placeHolder: 'Select service type'
    }
  );

  if (!serviceType) {
    return;
  }

  // Start debugging in copilot
  await copilot.startDebugging(serviceName, serviceType.toLowerCase());
}

async function connectToAWS() {
  const accessKeyId = await vscode.window.showInputBox({
    prompt: 'Enter AWS Access Key ID',
    password: false,
    ignoreFocusOut: true
  });

  if (!accessKeyId) {
    return;
  }

  const secretAccessKey = await vscode.window.showInputBox({
    prompt: 'Enter AWS Secret Access Key',
    password: true,
    ignoreFocusOut: true
  });

  if (!secretAccessKey) {
    return;
  }

  const region = await vscode.window.showQuickPick(
    ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-south-1'],
    {
      placeHolder: 'Select AWS Region'
    }
  );

  if (!region) {
    return;
  }

  // Store credentials securely
  await vscode.workspace.getConfiguration('tivra').update('awsRegion', region, true);

  vscode.window.showInformationMessage(
    `✅ Connected to AWS (${region}). Run "Tivra: Start Debugging" to begin!`
  );

  statusBarItem.text = '$(bug) DebugMind (Connected)';
}

function showWelcomeMessage(context: vscode.ExtensionContext) {
  vscode.window.showInformationMessage(
    '🤖 Welcome to Tivra DebugMind! Your AI debugging assistant.',
    'Start Debugging'
  ).then(choice => {
    if (choice === 'Start Debugging') {
      copilot = DebugCopilot.createOrShow(context.extensionUri, context, apiUrl, credentialManager, analytics);
    }
  });
}

export function deactivate() {
  if (copilot) {
    copilot.dispose();
  }
}
