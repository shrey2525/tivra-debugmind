// Tivra DebugMind - Smart Debugging Copilot
// Conversational AI that analyzes errors and fixes code

import * as vscode from 'vscode';
import axios from 'axios';
import { E2EEncryption } from '../utils/e2e-encryption';
import { CredentialManager, AWSCredentials } from '../utils/credential-manager';
import { AnalyticsTracker } from '../analytics/analytics-tracker';
import { PermissionManager } from '../utils/permission-manager';
import { LocalLogParser } from '../utils/log-parser';

export class DebugCopilot {
  public static currentPanel: DebugCopilot | undefined;
  private readonly _panel: vscode.WebviewPanel;
  private _disposables: vscode.Disposable[] = [];
  private _messages: ChatMessage[] = [];
  private _conversationContext: ConversationContext;
  private _apiUrl: string;
  private _awsConnectionState: {
    step: 'ACCESS_KEY' | 'SECRET_KEY' | 'REGION' | 'EC2_LOG_GROUP';
    accessKeyId?: string;
    secretAccessKey?: string;
    region?: string;
    serviceName?: string;
    logGroupName?: string;
  } | null = null;
  private _isMonitoring: boolean = false;
  private _awsServices: any[] = [];
  private _errorAnalysisData: any = null; // Store analysis for context
  private _servicesNeedingLogGroup: any[] = []; // Services that need manual log group config

  // Autonomous monitoring (agent-side, no polling)
  private _autonomousMonitoringActive: boolean = false;

  // E2E Encryption
  private _encryption: E2EEncryption | null = null;
  private _encryptionEnabled: boolean = true; // Enable encryption by default

  // Credential Manager
  private _credentialManager: CredentialManager;

  // Analytics
  private _analytics: AnalyticsTracker | undefined;

  // Permission Manager
  private _permissionManager: PermissionManager;

  // Extension context (for globalState persistence)
  private _context: vscode.ExtensionContext;

  // GitHub OAuth data
  private _githubData: {
    token: string;
    owner: string;
    repo: string;
    baseBranch: string;
    user: any;
  } | null = null;

  // Last investigation result (for "Explain the fix")
  private _lastInvestigationResult: any = null;

  // Pending feedback session ID (for post-validation feedback)
  private _pendingFeedbackSessionId: string | null = null;

  private constructor(panel: vscode.WebviewPanel, extensionUri: vscode.Uri, context: vscode.ExtensionContext, apiUrl: string, credentialManager: CredentialManager, analytics?: AnalyticsTracker) {
    this._panel = panel;
    this._context = context;
    this._apiUrl = apiUrl;
    this._credentialManager = credentialManager;
    this._analytics = analytics;
    this._permissionManager = new PermissionManager(apiUrl);

    // Restore GitHub OAuth data from globalState (persists across reloads)
    this._githubData = this._context.globalState.get('tivra_github_data') || null;
    if (this._githubData) {
      console.log(`[Tivra DebugMind] Restored GitHub connection: ${this._githubData.owner}/${this._githubData.repo}`);
    }

    // Restore AWS services from globalState (persists across reloads)
    this._awsServices = this._context.globalState.get('tivra_aws_services') || [];
    if (this._awsServices.length > 0) {
      console.log(`[Tivra DebugMind] Restored ${this._awsServices.length} AWS service(s) from previous session`);
    }

    // Initialize E2E encryption
    this._encryption = new E2EEncryption(apiUrl);
    this._conversationContext = {
      service: null,
      recentErrors: [],
      appliedFixes: [],
      conversationHistory: []
    };

    this._panel.webview.html = this._getHtmlForWebview(this._panel.webview, extensionUri);

    // Handle messages from webview
    this._panel.webview.onDidReceiveMessage(
      message => {
        switch (message.type) {
          case 'userMessage':
            this.handleUserMessage(message.text);
            break;
          case 'applyFix':
            this.applyFix(message.fix);
            break;
          case 'rejectFix':
            this.handleFixRejection(message.reason);
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

  /**
   * Show welcome message with instructions
   */
  private async showWelcomeMessage() {
    // Show RCA-focused welcome message
    this.addMessage({
      type: 'ai',
      content: `**Welcome to Tivra DebugMind** 🤖\n\n**Paste your error logs below to get instant RCA**\n\nI'll automatically:\n• Detect error patterns and exceptions\n• Scan your workspace for relevant files\n• Analyze root causes\n• Suggest fixes\n\n**Optional:** Connect to AWS for better experience with:\n• Real-time CloudWatch log fetching\n• Deployment history correlation\n• Auto-generated PRs\n\n*Just paste your error logs below to begin...*`,
      timestamp: new Date(),
      suggestedPrompts: ['Connect to AWS (Optional)']
    });
  }

  public static createOrShow(extensionUri: vscode.Uri, context: vscode.ExtensionContext, apiUrl: string, credentialManager: CredentialManager, analytics?: AnalyticsTracker) {
    const column = vscode.ViewColumn.Two;

    if (DebugCopilot.currentPanel) {
      DebugCopilot.currentPanel._panel.reveal(column);
      analytics?.trackFeatureUsage('copilot', 'reveal_existing');
      return DebugCopilot.currentPanel;
    }

    const panel = vscode.window.createWebviewPanel(
      'tivraDebugMind',
      '🤖 Tivra DebugMind',
      column,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [extensionUri]
      }
    );

    DebugCopilot.currentPanel = new DebugCopilot(panel, extensionUri, context, apiUrl, credentialManager, analytics);
    analytics?.trackFeatureUsage('copilot', 'create_new');
    return DebugCopilot.currentPanel;
  }

  /**
   * Handle AWS credential input
   */
  private async handleAWSCredentialInput(input: string) {
    if (!this._awsConnectionState) return false;

    switch (this._awsConnectionState.step) {
      case 'ACCESS_KEY':
        this._awsConnectionState.accessKeyId = input.trim();
        console.log('[DEBUG] Access Key ID stored, length:', this._awsConnectionState.accessKeyId.length);
        this._awsConnectionState.step = 'SECRET_KEY';
        this.addMessage({
          type: 'ai',
          content: `✅ Access Key ID saved!\n\n**Step 2 of 3: AWS Secret Access Key**\n\nPlease enter your AWS Secret Access Key.\n\n🔒 Don't worry, this will be securely stored and not displayed.\n\n*Type your Secret Access Key below:*`,
          timestamp: new Date()
        });
        return true;

      case 'SECRET_KEY':
        this._awsConnectionState.secretAccessKey = input.trim();
        console.log('[DEBUG] Secret Key stored, length:', this._awsConnectionState.secretAccessKey.length);
        this._awsConnectionState.step = 'REGION';
        this.addMessage({
          type: 'ai',
          content: `✅ Secret Access Key saved!\n\n**Step 3 of 3: AWS Region**\n\nWhich AWS region would you like to connect to?\n\nExamples: \`us-east-1\`, \`us-west-2\`, \`eu-west-1\`\n\n*Type your AWS region below:*`,
          timestamp: new Date(),
          suggestedPrompts: ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-south-1']
        });
        return true;

      case 'REGION':
        this._awsConnectionState.region = input.trim();
        await this.connectToAWS(
          this._awsConnectionState.accessKeyId!,
          this._awsConnectionState.secretAccessKey!,
          this._awsConnectionState.region
        );
        this._awsConnectionState = null;
        return true;

      case 'EC2_LOG_GROUP':
        const serviceName = this._awsConnectionState.serviceName!;
        const logGroupName = input.trim();

        this.addMessage({
          type: 'ai',
          content: `✅ **Log Group Configured**\n\nAnalyzing logs from \`${logGroupName}\` for **${serviceName}**...`,
          timestamp: new Date()
        });

        // Analyze with the provided log group
        await this.analyzeServiceWithLogGroup(serviceName, 'ec2', logGroupName);

        this._awsConnectionState = null;
        return true;
    }

    return false;
  }

  /**
   * Connect to AWS with provided credentials
   */
  private async connectToAWS(accessKeyId: string, secretAccessKey: string, region: string) {
    console.log(`[Tivra DebugMind] Connecting to AWS... Region: ${region}, API: ${this._apiUrl}`);
    console.log('[DEBUG] Access Key ID length:', accessKeyId?.length);
    console.log('[DEBUG] Access Key ID value:', accessKeyId);
    console.log('[DEBUG] Secret Key length:', secretAccessKey?.length);
    console.log('[DEBUG] Region:', region);

    this.addMessage({
      type: 'system',
      content: `🔄 Connecting to AWS...`,
      timestamp: new Date()
    });

    try {
      // Initialize E2E encryption if enabled
      if (this._encryptionEnabled && this._encryption) {
        console.log('[E2E] Establishing secure session...');
        const sessionEstablished = await this._encryption.initiateSession();

        if (!sessionEstablished) {
          console.warn('[E2E] Failed to establish secure session, falling back to unencrypted');
          this._encryptionEnabled = false;
        } else {
          console.log('✅ [E2E] Secure session established');
          this.addMessage({
            type: 'system',
            content: `🔐 Secure connection established (E2E encrypted)`,
            timestamp: new Date()
          });
        }
      }

      let response;

      // Send encrypted request if encryption is enabled
      if (this._encryptionEnabled && this._encryption && this._encryption.isSessionActive()) {
        console.log('[E2E] Sending encrypted AWS credentials...');
        response = await this._encryption.sendEncryptedRequest('/api/aws/connect', {
          accessKeyId,
          secretAccessKey,
          region
        }, 'POST');
      } else {
        // Fallback to unencrypted
        console.log('[E2E] Sending unencrypted request (encryption disabled)');
        response = await axios.post(`${this._apiUrl}/api/aws/connect`, {
          accessKeyId,
          secretAccessKey,
          region
        });
        response = response.data;
      }

      console.log('[Tivra DebugMind] AWS connection response:', response);

      if (response.success) {
        // Store credentials securely in VS Code SecretStorage
        await this._credentialManager.storeManualCredentials({
          accessKeyId,
          secretAccessKey,
          region
        });
        console.log('[Tivra DebugMind] Credentials stored securely in SecretStorage');

        // Track successful AWS connection
        this._analytics?.trackFunnelStep('aws_connected', {
          region,
          encrypted: this._encryptionEnabled
        });
        this._analytics?.trackFeatureUsage('aws', 'connect_success', { region });

        this.addMessage({
          type: 'ai',
          content: `**AWS Connected** ✅\n\nRegion: ${region}\n${this._encryptionEnabled ? '🔐 Using E2E encryption\n' : ''}🔒 Credentials stored securely\n\nFetching AWS services...`,
          timestamp: new Date()
        });

        // Fetch AWS services
        await this.fetchAWSServices(region);
      } else {
        throw new Error(response.error || 'Connection failed');
      }
    } catch (error: any) {
      console.error('[Tivra DebugMind] AWS connection error:', error);

      // Track AWS connection failure
      this._analytics?.trackError('aws_connection_failed', error.message);
      this._analytics?.trackFeatureUsage('aws', 'connect_failed', {
        error: error.message
      });

      this.addMessage({
        type: 'ai',
        content: `❌ **Failed to connect to AWS**\n\nError: ${error.response?.data?.error || error.message}\n\nPlease check your credentials and try again.\n\nWould you like to:\n• Try connecting again\n• Get help with AWS credentials`,
        timestamp: new Date(),
        suggestedPrompts: [
          'Connect me to AWS',
          'How do I get AWS credentials?'
        ]
      });
    }
  }

  /**
   * Disconnect from AWS and clear all credentials
   */
  private async disconnectFromAWS() {
    console.log('[Tivra DebugMind] Disconnecting from AWS...');

    this.addMessage({
      type: 'system',
      content: `🔄 Disconnecting from AWS...`,
      timestamp: new Date()
    });

    try {
      // Clear credentials from VS Code SecretStorage
      await this._credentialManager.clearCredentials();
      console.log('[Tivra DebugMind] Credentials cleared from SecretStorage');

      // Call server disconnect endpoint
      await axios.post(`${this._apiUrl}/api/aws/disconnect`);
      console.log('[Tivra DebugMind] Server disconnected');

      // Clear local state
      this._awsServices = [];
      this._awsConnectionState = null;

      // Clear persisted services from globalState
      await this._context.globalState.update('tivra_aws_services', []);
      console.log('[Tivra DebugMind] Cleared persisted AWS services');

      this.addMessage({
        type: 'ai',
        content: `✅ **Disconnected from AWS**\n\nAll credentials have been cleared securely.\n\n**Connect to AWS** 🔗\n\nI'll help you connect using your AWS Access Keys.`,
        timestamp: new Date(),
        suggestedPrompts: [
          'Use Access Keys'
          // 'Use SSO' // TODO: SSO flow - fix later
        ]
      });
    } catch (error: any) {
      console.error('[Tivra DebugMind] Disconnect error:', error);
      this.addMessage({
        type: 'ai',
        content: `⚠️ **Disconnect Warning**\n\nThere was an issue disconnecting: ${error.message}\n\nCredentials have been cleared locally. You can try connecting again.`,
        timestamp: new Date(),
        suggestedPrompts: [
          'Use Access Keys'
          // 'Use SSO' // TODO: SSO flow - fix later
        ]
      });
    }
  }

  /**
   * Start manual AWS keys flow
   */
  private startManualKeysFlow() {
    this.addMessage({
      type: 'ai',
      content: `**AWS Access Keys Authentication** 🔑\n\n**How to get your AWS credentials:**\n\n1. Go to [AWS IAM Console](https://console.aws.amazon.com/iam/)\n2. Click "Users" → Select your user\n3. Go to "Security credentials" tab\n4. Click "Create access key"\n5. Copy the Access Key ID and Secret Access Key\n\n**Step 1 of 3: AWS Access Key ID**\n\n*Type your Access Key ID below:*`,
      timestamp: new Date()
    });

    // Set state to wait for access key
    this._awsConnectionState = { step: 'ACCESS_KEY' };
  }

  /**
   * Start AWS SSO authentication flow
   */
  private async startSSOFlow() {
    console.log('[SSO] Starting SSO authentication flow...');

    // Show help message first
    this.addMessage({
      type: 'ai',
      content: `**AWS SSO Authentication** 🔐\n\n**How to find your SSO Start URL:**\n\n1. Go to your organization's AWS SSO portal\n2. The URL looks like: \`https://my-company.awsapps.com/start\`\n3. Or ask your AWS administrator for the SSO portal URL\n\n**Benefits of SSO:**\n• No long-term credentials to manage\n• Automatic token refresh\n• Enterprise-grade security\n• Multi-account support\n\nI'll now ask you for your SSO Start URL...`,
      timestamp: new Date()
    });

    try {
      // Prompt user for SSO Start URL
      console.log('[SSO] Showing input box for SSO Start URL...');
      const ssoStartUrl = await vscode.window.showInputBox({
        prompt: 'Enter your AWS SSO Start URL',
        placeHolder: 'https://my-company.awsapps.com/start',
        ignoreFocusOut: true,
        validateInput: (value) => {
          if (!value) return 'SSO Start URL is required';
          if (!value.startsWith('https://')) return 'URL must start with https://';
          if (!value.includes('awsapps.com')) return 'Must be a valid AWS SSO portal URL';
          return null;
        }
      });

      console.log('[SSO] Input box returned, value:', ssoStartUrl ? 'provided' : 'null/cancelled');

      if (!ssoStartUrl) {
        console.log('[SSO] User cancelled SSO URL input');
        this._awsConnectionState = null;
        this.addMessage({
          type: 'ai',
          content: `AWS SSO authentication cancelled.\n\nWould you like to try again?`,
          timestamp: new Date(),
          suggestedPrompts: ['Use Access Keys'] // 'Use SSO' - TODO: fix later
        });
        return;
      }

      console.log('[SSO] SSO URL provided:', ssoStartUrl);

      // Prompt for region
      const ssoRegion = await vscode.window.showQuickPick(
        ['us-east-1', 'us-west-2', 'eu-west-1', 'ap-south-1', 'eu-central-1'],
        {
          placeHolder: 'Select your AWS SSO Region',
          ignoreFocusOut: true
        }
      );

      if (!ssoRegion) {
        console.log('[SSO] User cancelled region selection');
        this._awsConnectionState = null;
        this.addMessage({
          type: 'ai',
          content: `AWS SSO authentication cancelled.\n\nWould you like to try again?`,
          timestamp: new Date(),
          suggestedPrompts: ['Use Access Keys'] // 'Use SSO' - TODO: fix later
        });
        return;
      }

      console.log('[SSO] Region selected:', ssoRegion);
      console.log('[SSO] API URL:', this._apiUrl);

      this.addMessage({
        type: 'system',
        content: `🔐 Initiating AWS SSO authentication...\n\nSSO Portal: ${ssoStartUrl}\nRegion: ${ssoRegion}`,
        timestamp: new Date()
      });

      // Step 1: Initialize SSO OAuth flow
      console.log('[SSO] Calling POST', `${this._apiUrl}/api/aws/oauth/init`);
      const initResponse = await axios.post(`${this._apiUrl}/api/aws/oauth/init`, {
        ssoStartUrl,
        ssoRegion
      });

      console.log('[SSO] Init response status:', initResponse.status);
      console.log('[SSO] Init response data:', JSON.stringify(initResponse.data, null, 2));

      if (!initResponse.data.ok) {
        console.error('[SSO] Init failed:', initResponse.data.error);
        throw new Error(initResponse.data.error || 'Failed to initialize SSO');
      }

      const { sessionId, userCode, verificationUriComplete, verificationUri, interval, expiresIn } = initResponse.data;

      // Show device code to user and open browser
      const verifyUrl = verificationUriComplete || verificationUri;

      this.addMessage({
        type: 'ai',
        content: `**📱 Device Authorization Required**\n\n1. I'll open your browser to: ${verifyUrl}\n\n2. Enter this code: **${userCode}**\n\n3. Approve the request in your browser\n\n4. I'll automatically detect when you're authenticated\n\n*Opening browser now...*`,
        timestamp: new Date()
      });

      // Open browser for user to authenticate
      await vscode.env.openExternal(vscode.Uri.parse(verifyUrl));

      // Start polling for authorization
      await this.pollForSSOAuthorization(sessionId, interval || 5, expiresIn);

    } catch (error: any) {
      console.error('[Tivra DebugMind] SSO flow error:', error);
      this._awsConnectionState = null;
      this.addMessage({
        type: 'ai',
        content: `❌ **SSO Authentication Failed**\n\nError: ${error.response?.data?.error || error.message}\n\nWould you like to try again?`,
        timestamp: new Date(),
        suggestedPrompts: ['Use AWS SSO', 'Use Manual Keys']
      });
    }
  }

  /**
   * Poll for SSO authorization completion
   */
  private async pollForSSOAuthorization(sessionId: string, interval: number, expiresIn: number) {
    const maxAttempts = Math.floor(expiresIn / interval);
    let attempts = 0;

    const pollInterval = setInterval(async () => {
      attempts++;

      try {
        const pollResponse = await axios.post(`${this._apiUrl}/api/aws/oauth/poll`, {
          sessionId
        });

        if (pollResponse.data.authorized) {
          clearInterval(pollInterval);

          const { accounts, accessToken, expiresIn } = pollResponse.data;

          this.addMessage({
            type: 'ai',
            content: `✅ **AWS SSO Authentication Successful!**\n\nFound ${accounts.length} AWS account(s):\n${accounts.map((acc: any) => `• ${acc.accountName} (${acc.accountId})`).join('\n')}\n\nSelect an account to continue:`,
            timestamp: new Date()
          });

          // Let user select account
          await this.selectSSOAccount(sessionId, accounts, accessToken, expiresIn);
        } else if (pollResponse.data.expired) {
          clearInterval(pollInterval);
          this._awsConnectionState = null;
          this.addMessage({
            type: 'ai',
            content: `⏰ **Authorization Expired**\n\nThe device code has expired. Please try again.`,
            timestamp: new Date(),
            suggestedPrompts: ['Use Access Keys'] // 'Use SSO' - TODO: fix later
          });
        }

      } catch (error: any) {
        if (attempts >= maxAttempts) {
          clearInterval(pollInterval);
          this._awsConnectionState = null;
          this.addMessage({
            type: 'ai',
            content: `⏰ **Authorization Timeout**\n\nDidn't receive authorization in time. Please try again.`,
            timestamp: new Date(),
            suggestedPrompts: ['Use Access Keys'] // 'Use SSO' - TODO: fix later
          });
        }
      }
    }, interval * 1000);
  }

  /**
   * Let user select AWS account and role for SSO
   */
  private async selectSSOAccount(sessionId: string, accounts: any[], accessToken: string, expiresIn: number) {
    try {
      // Show account picker
      const selectedAccount = await vscode.window.showQuickPick(
        accounts.map((acc: any) => ({
          label: acc.accountName || acc.accountId,
          description: acc.accountId,
          detail: acc.emailAddress,
          account: acc
        })),
        {
          placeHolder: 'Select AWS Account',
          ignoreFocusOut: true
        }
      );

      if (!selectedAccount) {
        this._awsConnectionState = null;
        this.addMessage({
          type: 'ai',
          content: `Account selection cancelled.`,
          timestamp: new Date(),
          suggestedPrompts: ['Use Access Keys'] // 'Use SSO' - TODO: fix later
        });
        return;
      }

      this.addMessage({
        type: 'system',
        content: `🔄 Getting credentials for ${selectedAccount.label}...`,
        timestamp: new Date()
      });

      // Get role credentials
      const credsResponse = await axios.post(`${this._apiUrl}/api/aws/oauth/credentials`, {
        sessionId,
        accountId: selectedAccount.account.accountId
      });

      if (!credsResponse.data.ok) {
        throw new Error(credsResponse.data.error || 'Failed to get credentials');
      }

      const { credentials, account } = credsResponse.data;

      // Store SSO credentials in SecretStorage
      const expiresAt = Date.now() + (expiresIn * 1000);
      await this._credentialManager.storeSSOCredentials({
        accessToken,
        accountId: account.id,
        roleName: account.roleName,
        region: 'us-east-1', // TODO: get from user or SSO config
        expiresAt
      });

      console.log('[Tivra DebugMind] SSO credentials stored securely');

      this._awsConnectionState = null;

      this.addMessage({
        type: 'ai',
        content: `**AWS SSO Connected** ✅\n\nAccount: ${account.name}\nRole: ${account.roleName}\n🔒 SSO credentials stored securely\n\nFetching AWS services...`,
        timestamp: new Date()
      });

      // Fetch AWS services
      await this.fetchAWSServices('us-east-1'); // TODO: use actual region

    } catch (error: any) {
      console.error('[Tivra DebugMind] Account selection error:', error);
      this._awsConnectionState = null;
      this.addMessage({
        type: 'ai',
        content: `❌ **Failed to get credentials**\n\nError: ${error.response?.data?.error || error.message}`,
        timestamp: new Date(),
        suggestedPrompts: ['Use AWS SSO', 'Use Manual Keys']
      });
    }
  }

  /**
   * Fetch AWS services after connection
   */
  private async fetchAWSServices(region: string) {
    console.log(`[Tivra DebugMind] Fetching AWS services for region: ${region}`);

    try {
      const response = await axios.get(`${this._apiUrl}/api/aws/services/discover`);
      console.log('[Tivra DebugMind] Services response:', response.data);

      // Add region to each service
      this._awsServices = (response.data.services || []).map((service: any) => ({
        ...service,
        region: region
      }));
      console.log(`[Tivra DebugMind] Found ${this._awsServices.length} services`);

      // Persist discovered services to globalState
      await this._context.globalState.update('tivra_aws_services', this._awsServices);
      console.log(`[Tivra DebugMind] Persisted ${this._awsServices.length} AWS services`);

      if (this._awsServices.length > 0) {
        // Build services list message
        const servicesList = this._awsServices.map((service: any) =>
          `• **${service.name}** (${service.type})`
        ).join('\n');

        this.addMessage({
          type: 'ai',
          content: `**AWS Services Found** ✅\n\n${servicesList}\n\nAnalyzing services for errors...`,
          timestamp: new Date()
        });

        // Automatically analyze services after discovery
        await this.analyzeAllServices();
      } else {
        // No services found
        this.addMessage({
          type: 'ai',
          content: `**No AWS Services Running** ℹ️\n\nNo Lambda functions or other services were found in region ${region}.\n\nPlease ensure you have:\n• Lambda functions deployed\n• Proper IAM permissions\n• Services in the selected region\n\nWould you like to try a different region?`,
          timestamp: new Date(),
          suggestedPrompts: [
            'Connect to a different region',
            'Help me deploy a Lambda function'
          ]
        });
      }
    } catch (error: any) {
      console.error('[Tivra DebugMind] Error fetching services:', error);
      this.addMessage({
        type: 'ai',
        content: `⚠️ **Could not fetch services**\n\nError: ${error.response?.data?.error || error.message}\n\nProceeding with manual service selection...`,
        timestamp: new Date()
      });
    }
  }

  /**
   * Analyze a service with a specific log group
   */
  private async analyzeServiceWithLogGroup(serviceName: string, serviceType: string, logGroupName: string) {
    console.log(`[Tivra DebugMind] Analyzing service with provided log group:`);
    console.log(`  Service: ${serviceName}`);
    console.log(`  Type: ${serviceType}`);
    console.log(`  Log Group: ${logGroupName}`);
    console.log(`  API URL: ${this._apiUrl}/api/aws/logs`);

    try {
      console.log('[Tivra DebugMind] Sending API request...');
      const response = await axios.get(`${this._apiUrl}/api/aws/logs`, {
        params: {
          serviceName: serviceName,
          serviceType: serviceType,
          logGroupName: logGroupName
        }
      });

      console.log('[Tivra DebugMind] API Response received:');
      console.log(`  Status: ${response.status}`);
      console.log(`  Error Count: ${response.data.errorCount}`);
      console.log(`  Top Errors: ${response.data.topErrors?.length || 0}`);
      console.log(`  Message: ${response.data.message || 'N/A'}`);

      if (response.data.errorCount > 0) {
        // Find service from discovered services to get region
        const awsService = this._awsServices.find(s => s.name === serviceName);

        // Store service context with log group for later use
        this._conversationContext.service = {
          name: serviceName,
          type: serviceType,
          logGroupName: logGroupName,
          region: awsService?.region || this._awsConnectionState?.region || 'us-east-1'
        };
        this._conversationContext.recentErrors = response.data.topErrors;

        // Update the service in _awsServices array with logGroupName for persistence
        const serviceIndex = this._awsServices.findIndex(s => s.name === serviceName);
        if (serviceIndex !== -1) {
          this._awsServices[serviceIndex] = {
            ...this._awsServices[serviceIndex],
            logGroupName: logGroupName
          };
          // Persist to globalState
          await this._context.globalState.update('tivra_aws_services', this._awsServices);
          console.log(`[Tivra DebugMind] Persisted logGroupName for ${serviceName}`);
        }

        // Store complete CloudWatch analysis for SRE agent
        this._errorAnalysisData = {
          logs: response.data,
          timestamp: new Date().toISOString()
        };

        // Track service selection and analysis start
        this._analytics?.trackFunnelStep('first_service_selected', {
          serviceName,
          serviceType,
          errorCount: response.data.errorCount
        });
        this._analytics?.trackFeatureUsage('service', 'analyze_start', {
          serviceType,
          errorCount: response.data.errorCount
        });

        // Show errors found with summary
        let errorMessage = `**⚠️ Errors Found in ${serviceName}**\n\n`;
        errorMessage += `Found **${response.data.errorCount} error(s)** in the last hour.\n\n`;

        // Show top errors with more details
        if (response.data.topErrors && response.data.topErrors.length > 0) {
          errorMessage += `**Top Errors (showing ${Math.min(5, response.data.topErrors.length)}):**\n\n`;
          response.data.topErrors.slice(0, 5).forEach((err: any, i: number) => {
            errorMessage += `${i + 1}. **${err.message || err.type}**\n`;
            errorMessage += `   • Occurrences: ${err.count}\n`;
            if (err.lastSeen) {
              errorMessage += `   • Last seen: ${new Date(err.lastSeen).toLocaleString()}\n`;
            }
            errorMessage += '\n';
          });

          // Add summary statistics
          const totalOccurrences = response.data.topErrors.reduce((sum: number, err: any) => sum + (err.count || 0), 0);
          errorMessage += `**Summary:**\n`;
          errorMessage += `• Total error occurrences: ${totalOccurrences}\n`;
          errorMessage += `• Unique error types: ${response.data.topErrors.length}\n`;
          errorMessage += `• Time period: Last 60 minutes\n`;
        }

        // Show errors with two-path prompts (explain or investigate)
        this.addMessage({
          type: 'ai',
          content: errorMessage,
          timestamp: new Date(),
          suggestedPrompts: [
            'Explain errors in detail',
            'Start investigation',
            'Skip for now'
          ]
        });

        // Track error detection
        this._analytics?.trackFeatureUsage('service', 'errors_found', {
          serviceName,
          serviceType,
          errorCount: response.data.errorCount
        });
      } else {
        this.addMessage({
          type: 'ai',
          content: `✅ **No Errors Found**\n\nNo errors detected in **${serviceName}** logs from \`${logGroupName}\` in the last hour.`,
          timestamp: new Date()
        });
      }
    } catch (error: any) {
      console.error('[Tivra DebugMind] Error analyzing service with log group:', error);
      console.error(`  Service: ${serviceName}`);
      console.error(`  Log Group: ${logGroupName}`);
      console.error(`  Error Message: ${error.message}`);
      console.error(`  Response Status: ${error.response?.status}`);
      console.error(`  Response Data:`, error.response?.data);

      this.addMessage({
        type: 'ai',
        content: `❌ **Analysis Failed**\n\nCould not analyze logs: ${error.response?.data?.message || error.message}\n\nPlease verify:\n• Log group name is correct\n• You have CloudWatch Logs permissions\n• The log group exists in your AWS account`,
        timestamp: new Date()
      });
    }
  }

  /**
   * Trigger SRE Agent Investigation
   * Sends comprehensive context to the SRE agent for deep investigation
   */
  /**
   * NEW RCA FLOW: Handle pasted error logs and perform RCA analysis
   */
  private async handleRCAFlow(rawLogs: string) {
    console.log('[Tivra DebugMind] Starting RCA flow for pasted logs');

    // Step 1: Auto-detect patterns
    this.addMessage({
      type: 'system',
      content: `🔍 **Auto-detecting patterns...**`,
      timestamp: new Date()
    });

    let parsedLogs;
    try {
      const logParser = new LocalLogParser();
      parsedLogs = logParser.parse(rawLogs);
    } catch (error: any) {
      console.error('[Tivra DebugMind] Log parsing failed:', error);
      this.addMessage({
        type: 'ai',
        content: `❌ **Failed to Parse Logs**\n\nError: ${error.message}\n\nPlease ensure your logs:\n• Are properly formatted\n• Contain at least 5 lines\n• Include error messages (ERROR, FATAL, CRITICAL, SEVERE, Exception)\n\n*Try pasting your logs again.*`,
        timestamp: new Date()
      });
      return;
    }

    // Step 2: Show detected patterns
    if (parsedLogs.errors.length === 0) {
      // No errors found by frontend parser, but backend can still analyze raw logs
      console.log('[Tivra DebugMind] Frontend parser found no errors, proceeding with backend analysis');
      this.addMessage({
        type: 'ai',
        content: `🔍 **Analyzing Logs...**\n\n**Detected Format:** ${parsedLogs.detectedFormat}\n**Total Lines:** ${parsedLogs.totalLines}\n\nFrontend pattern matching didn't find structured errors, but sending raw logs to backend for AI analysis...\n\n📡 Analyzing with Claude...`,
        timestamp: new Date()
      });
    } else {
      const errorSummary = parsedLogs.errors.map((err, idx) =>
        `${idx + 1}. **${err.message}** (${err.count}x)`
      ).join('\n');

      this.addMessage({
        type: 'ai',
        content: `✅ **Pattern Detection Complete**\n\n**Detected Format:** ${parsedLogs.detectedFormat}\n**Total Lines:** ${parsedLogs.totalLines}\n**Errors Found:** ${parsedLogs.errors.length}\n\n**Error Summary:**\n${errorSummary}\n\n🔍 Scanning workspace for relevant files...`,
        timestamp: new Date()
      });
    }

    // Step 3: Workspace scan - Always scan workspace for code context
    // Even if frontend parser found no errors, backend Claude might need code files
    const workspaceContext = await this.scanWorkspaceForContext({ ...parsedLogs, rawLogs});

    // Show workspace scan message
    this.addMessage({
      type: 'ai',
      content: `✅ **Workspace Scan Complete**\n\nFound ${workspaceContext.files.length} relevant files\n\n📡 Sending to backend for RCA analysis...`,
      timestamp: new Date()
    });

    // Step 4: Backend analysis
    try {
      const requestPayload = {
        logs: rawLogs,
        service_name: 'pasted-logs',
        code_context: workspaceContext.files.length > 0 ? {
          files: workspaceContext.files.map((f: any) => ({
            file_path: f.path,
            file_name: f.name,
            line_number: f.lineNumber,
            method: f.method,
            class_name: f.className,
            content: f.fullContent || f.snippet, // Send full content if available
            language: this.detectLanguage(f.name)
          })),
          error_locations: workspaceContext.errorLocations || []
        } : undefined
      };

      console.log('[Tivra DebugMind] ===== BACKEND REQUEST PAYLOAD =====');
      console.log('[Tivra DebugMind] Logs length:', rawLogs.length);
      console.log('[Tivra DebugMind] Logs preview:', rawLogs.substring(0, 200));
      console.log('[Tivra DebugMind] Files count:', workspaceContext.files.length);
      console.log('[Tivra DebugMind] Error locations count:', workspaceContext.errorLocations?.length || 0);
      console.log('[Tivra DebugMind] Has code_context:', !!requestPayload.code_context);

      if (requestPayload.code_context) {
        console.log('[Tivra DebugMind] Code context files being sent:');
        requestPayload.code_context.files.forEach((f: any, idx: number) => {
          console.log(`[Tivra DebugMind]   ${idx + 1}. ${f.file_name} (${f.file_path}) - ${f.content?.length || 0} chars, language: ${f.language}`);
        });
      } else {
        console.log('[Tivra DebugMind] ⚠️ WARNING: No code_context in request payload!');
      }

      console.log('[Tivra DebugMind] Endpoint:', `${this._apiUrl}/api/try-mode/analyze`);
      console.log('[Tivra DebugMind] =====================================');

      const response = await axios.post(
        `${this._apiUrl}/api/try-mode/analyze`,
        requestPayload,
        {
          timeout: 60000 // 60 second timeout
        }
      );

      console.log('[Tivra DebugMind] RCA analysis completed:', {
        confidence: response.data.confidence,
        hasRootCause: !!response.data.root_cause,
        evidenceCount: response.data.evidence?.length || 0,
        hasFix: !!(response.data.suggested_fix || response.data.fix_code)
      });

      // Check if RCA confidence is too low (< 10%)
      if (response.data.confidence < 0.1) {
        console.warn('[Tivra DebugMind] Low confidence RCA result:', response.data);
        this.addMessage({
          type: 'ai',
          content: `⚠️ **Unable to Perform RCA**\n\n${response.data.root_cause || 'Could not analyze the logs automatically.'}\n\n**Possible reasons:**\n• Logs may not contain enough error context\n• Log format may not be recognized\n• Error patterns are unclear\n\n**Please ensure your logs:**\n• Have clear error messages with ERROR/FATAL/EXCEPTION keywords\n• Include stack traces\n• Have timestamps and service names\n• Are from a recent error occurrence\n\n*Try pasting more complete error logs with stack traces.*`,
          timestamp: new Date(),
          suggestedPrompts: ['Paste More Logs']
        });
        return;
      }

      // Step 5: Display RCA results
      await this.displayRCAResults(response.data);

    } catch (error: any) {
      console.error('[Tivra DebugMind] RCA analysis failed:', error);
      console.error('[Tivra DebugMind] Error details:', {
        status: error.response?.status,
        statusText: error.response?.statusText,
        data: error.response?.data,
        message: error.message
      });

      let errorMsg = `❌ **RCA Analysis Failed**\n\n`;

      if (error.response?.status === 400) {
        const details = error.response.data?.details || error.response.data?.error;
        errorMsg += `**Log Validation Error:**\n${details}\n\n`;
        errorMsg += `**Please ensure your logs:**\n`;
        errorMsg += `• Have timestamps\n`;
        errorMsg += `• Contain ERROR, FATAL, CRITICAL, or EXCEPTION keywords\n`;
        errorMsg += `• Include stack traces if available\n`;
        errorMsg += `• Are properly formatted application logs\n`;
      } else if (error.response?.status === 500) {
        errorMsg += `Server error during analysis.\n\n`;
        errorMsg += `Error: ${error.response.data?.error || 'Internal server error'}\n\n`;
        errorMsg += `Please try again or contact support if the issue persists.`;
      } else if (error.code === 'ECONNREFUSED') {
        errorMsg += `Cannot connect to backend server.\n\n`;
        errorMsg += `Please ensure the backend is running at: ${this._apiUrl}`;
      } else {
        errorMsg += `Error: ${error.response?.data?.error || error.message}\n\n`;
        errorMsg += `Please try again or paste different logs.`;
      }

      this.addMessage({
        type: 'ai',
        content: errorMsg,
        timestamp: new Date(),
        suggestedPrompts: ['Paste More Logs']
      });
    }
  }

  /**
   * Scan workspace for files relevant to the errors
   */
  private async scanWorkspaceForContext(parsedLogs: any): Promise<any> {
    const workspaceFolders = vscode.workspace.workspaceFolders;
    if (!workspaceFolders) {
      return { files: [], errorTypes: [], errorLocations: [] };
    }

    const relevantFiles: any[] = [];
    const errorTypes = parsedLogs.errors.map((err: any) => err.message);
    const errorLocations: any[] = [];
    const processedFiles = new Set<string>(); // Avoid duplicates

    try {
      // If no structured errors found, try to extract file paths directly from raw logs
      if (parsedLogs.errors.length === 0 && parsedLogs.rawLogs) {
        console.log('[Tivra DebugMind] No structured errors - extracting file paths from raw logs');
        const filePathMatches = [
          // Node.js/JavaScript stack traces: at ... (file:///path/to/file.js:568:16)
          /\(file:\/\/\/.*\/([\w.-]+\.[jt]sx?):(\d+):(\d+)\)/g,
          // Node.js/JavaScript stack traces: at ... (/path/to/file.js:123:45)
          /\([^)]*\/([\w.-]+\.[jt]sx?):(\d+):(\d+)\)/g,
          // Python stack traces: File "/path/to/file.py", line 123
          /File\s+"[^"]*\/([\w.-]+\.py)",\s+line\s+(\d+)/g,
          // Java stack traces: at com.example.Class.method(File.java:123)
          /at\s+[\w.]+\(([\w.-]+\.java):(\d+)\)/g
        ];

        for (const regex of filePathMatches) {
          let match;
          while ((match = regex.exec(parsedLogs.rawLogs)) !== null) {
            const fileName = match[1]; // Filename is always first capture group now
            const lineNumber = parseInt(match[2] || '0', 10); // Line number is always second
            const fileKey = `${fileName}:${lineNumber}`;

            if (processedFiles.has(fileKey)) {
              console.log(`[Tivra DebugMind] Skipping already processed file: ${fileKey}`);
              continue;
            }

            console.log(`[Tivra DebugMind] Found file reference in raw logs: ${fileName}:${lineNumber}`);
            console.log(`[Tivra DebugMind] Searching workspace for pattern: **/${fileName}`);

            // Search for this file in workspace
            const files = await vscode.workspace.findFiles(`**/${fileName}`, '**/node_modules/**', 5);

            console.log(`[Tivra DebugMind] Workspace search returned ${files.length} file(s) for ${fileName}`);
            if (files.length > 0) {
              console.log(`[Tivra DebugMind] Found files: ${files.map(f => f.fsPath).join(', ')}`);
            }

            if (files.length > 0) {
              for (const file of files) {
                try {
                  const content = await vscode.workspace.fs.readFile(file);
                  const text = Buffer.from(content).toString('utf8');
                  const fileSizeKB = content.byteLength / 1024;

                  if (fileSizeKB > 1024) {
                    console.log(`[Tivra DebugMind] Skipping large file: ${fileName} (${fileSizeKB.toFixed(2)}KB)`);
                    continue;
                  }

                  console.log(`[Tivra DebugMind] Reading file from raw logs: ${fileName} (${fileSizeKB.toFixed(2)}KB)`);

                  relevantFiles.push({
                    path: file.fsPath,
                    name: fileName,
                    lineNumber: lineNumber || undefined,
                    fullContent: text,
                    snippet: lineNumber ? this.extractCodeSnippet(text, lineNumber) : undefined
                  });

                  if (lineNumber) {
                    errorLocations.push({
                      file: fileName,
                      line: lineNumber,
                      errorType: 'Stack trace entry'
                    });
                  }

                  processedFiles.add(fileKey);
                  break; // Only process first match
                } catch (fileError) {
                  console.error(`[Tivra DebugMind] Error reading file ${fileName}:`, fileError);
                }
              }
            }
          }
        }
      }

      // Use structured stack trace entries for more accurate file finding
      for (const error of parsedLogs.errors) {
        if (error.stackTraceEntries && error.stackTraceEntries.length > 0) {
          console.log(`[Tivra DebugMind] Processing ${error.stackTraceEntries.length} stack trace entries`);

          // Process each stack trace entry
          for (const entry of error.stackTraceEntries) {
            if (entry.file === 'unknown') {
              continue;
            }

            const fileName = entry.file;
            const fileKey = `${fileName}:${entry.line || 0}`;

            // Skip if already processed
            if (processedFiles.has(fileKey)) {
              continue;
            }

            console.log(`[Tivra DebugMind] Searching for file: ${fileName}`);

            // Search for this file in workspace
            const files = await vscode.workspace.findFiles(`**/${fileName}`, '**/node_modules/**', 5);

            if (files.length === 0) {
              console.log(`[Tivra DebugMind] File not found: ${fileName}`);
              continue;
            }

            for (const file of files) {
              try {
                const content = await vscode.workspace.fs.readFile(file);
                const text = Buffer.from(content).toString('utf8');

                // Check file size (skip files > 1MB to avoid overwhelming Claude)
                const fileSizeKB = content.byteLength / 1024;
                if (fileSizeKB > 1024) {
                  console.log(`[Tivra DebugMind] Skipping large file: ${fileName} (${fileSizeKB.toFixed(2)}KB)`);
                  continue;
                }

                console.log(`[Tivra DebugMind] Reading full file: ${fileName} (${fileSizeKB.toFixed(2)}KB)`);

                relevantFiles.push({
                  path: file.fsPath,
                  name: fileName,
                  lineNumber: entry.line,
                  method: entry.method,
                  className: entry.className,
                  fullContent: text, // Send full file content instead of snippet
                  snippet: entry.line ? this.extractCodeSnippet(text, entry.line) : undefined
                });

                // Track error location
                if (entry.line) {
                  errorLocations.push({
                    file: fileName,
                    line: entry.line,
                    method: entry.method,
                    className: entry.className,
                    errorType: error.message
                  });
                }

                processedFiles.add(fileKey);
                break; // Only process first match to avoid duplicates
              } catch (fileError) {
                console.error(`[Tivra DebugMind] Error reading file ${fileName}:`, fileError);
              }
            }
          }
        }
      }

      console.log(`[Tivra DebugMind] ===== WORKSPACE SCAN SUMMARY =====`);
      console.log(`[Tivra DebugMind] Found ${relevantFiles.length} relevant files`);
      console.log(`[Tivra DebugMind] Tracked ${errorLocations.length} error locations`);

      if (relevantFiles.length > 0) {
        console.log(`[Tivra DebugMind] Files to send to backend:`);
        relevantFiles.forEach((file, idx) => {
          console.log(`[Tivra DebugMind]   ${idx + 1}. ${file.name} (${file.path}) - ${(file.fullContent?.length || 0)} chars`);
        });
      } else {
        console.log(`[Tivra DebugMind] ⚠️ WARNING: No files found to send to backend!`);
      }
      console.log(`[Tivra DebugMind] ==================================`);

      return {
        files: relevantFiles,
        errorTypes: errorTypes,
        errorLocations: errorLocations,
        workspaceRoot: workspaceFolders[0].uri.fsPath
      };

    } catch (error) {
      console.error('[Tivra DebugMind] Workspace scan error:', error);
      return { files: [], errorTypes: [], errorLocations: [] };
    }
  }

  /**
   * Detect programming language from file name
   */
  private detectLanguage(fileName: string): string {
    const ext = fileName.split('.').pop()?.toLowerCase();
    const langMap: Record<string, string> = {
      'ts': 'typescript',
      'tsx': 'typescript',
      'js': 'javascript',
      'jsx': 'javascript',
      'py': 'python',
      'java': 'java',
      'go': 'go',
      'rb': 'ruby',
      'php': 'php',
      'cs': 'csharp',
      'cpp': 'cpp',
      'c': 'c',
      'rs': 'rust',
      'kt': 'kotlin',
      'swift': 'swift'
    };
    return langMap[ext || ''] || 'unknown';
  }

  /**
   * Extract code snippet around a specific line number
   */
  private extractCodeSnippet(fileContent: string, lineNumber: number, contextLines: number = 5): string {
    const lines = fileContent.split('\n');
    const startLine = Math.max(0, lineNumber - contextLines - 1);
    const endLine = Math.min(lines.length, lineNumber + contextLines);

    return lines.slice(startLine, endLine)
      .map((line, idx) => {
        const actualLineNum = startLine + idx + 1;
        const marker = actualLineNum === lineNumber ? '→' : ' ';
        return `${marker} ${actualLineNum}: ${line}`;
      })
      .join('\n');
  }

  /**
   * Display RCA analysis results
   */
  private async displayRCAResults(rcaData: any) {
    // Build RCA results message
    let resultsMsg = `✅ **Root Cause Analysis Complete**\n\n`;

    // Handle both root_cause and rootCause (try-mode uses snake_case)
    const rootCause = rcaData.root_cause || rcaData.rootCause;
    if (rootCause) {
      resultsMsg += `**🎯 Root Cause:**\n${rootCause}\n\n`;
    }

    // Show confidence if available
    if (rcaData.confidence !== undefined) {
      const confidencePercent = (rcaData.confidence * 100).toFixed(0);
      resultsMsg += `**📊 Confidence:** ${confidencePercent}%\n\n`;
    }

    // Show pinpointed error locations if available
    if (rcaData.error_locations && rcaData.error_locations.length > 0) {
      resultsMsg += `**📍 Error Locations:**\n`;
      rcaData.error_locations.forEach((loc: any, idx: number) => {
        const locLine = `${idx + 1}. ${loc.file}:${loc.line}`;
        const method = loc.method ? ` in method \`${loc.method}\`` : '';
        const issue = loc.issue ? ` - ${loc.issue}` : '';
        resultsMsg += `${locLine}${method}${issue}\n`;
      });
      resultsMsg += `\n`;
    }

    if (rcaData.evidence && rcaData.evidence.length > 0) {
      resultsMsg += `**📋 Evidence:**\n`;
      rcaData.evidence.forEach((item: string, idx: number) => {
        resultsMsg += `${idx + 1}. ${item}\n`;
      });
      resultsMsg += `\n`;
    }

    // Handle both suggested_actions and recommendedActions
    const actions = rcaData.suggested_actions || rcaData.recommendedActions || [];
    if (actions.length > 0) {
      resultsMsg += `**💡 Recommended Actions:**\n`;
      actions.forEach((action: string, idx: number) => {
        resultsMsg += `${idx + 1}. ${action}\n`;
      });
      resultsMsg += `\n`;
    }

    // Handle fix from try-mode format (suggested_fix, fix_code)
    const fixContent = rcaData.suggested_fix || rcaData.fix_code || rcaData.fix;
    if (fixContent) {
      resultsMsg += `**🔧 Suggested Fix:**\n\`\`\`\n${fixContent}\n\`\`\`\n\n`;
    }

    // Store the fix for later application, normalize format
    this._lastInvestigationResult = {
      ...rcaData,
      fix: fixContent,
      rootCause: rootCause,
      files: rcaData.fix_file ? [{ path: rcaData.fix_file }] : []
    };

    this.addMessage({
      type: 'ai',
      content: resultsMsg,
      timestamp: new Date(),
      suggestedPrompts: ['Connect to AWS for Better Experience', 'Paste More Logs']
    });

    // Track RCA completion
    this._analytics?.trackFeatureUsage('rca', 'analysis_complete');
  }

  /**
   * Apply fix from RCA analysis
   */
  private async applyRCAFix(fixData: any) {
    console.log('[Tivra DebugMind] Applying RCA fix');

    this.addMessage({
      type: 'system',
      content: `🔧 **Applying Fix...**`,
      timestamp: new Date()
    });

    try {
      // Parse fix data - it could be a string or structured object
      let filePath: string | undefined;
      let newCode: string;
      let explanation: string | undefined;

      if (typeof fixData === 'string') {
        // If fix is just a code string, try to extract file info from RCA data
        newCode = fixData;

        // Try to infer file path from workspace context or ask user
        const files = this._lastInvestigationResult?.files || [];
        if (files.length === 1) {
          filePath = files[0].path;
        } else if (files.length > 1) {
          // Ask user which file to apply to
          interface FileChoice extends vscode.QuickPickItem {
            path: string;
          }

          const fileChoices: FileChoice[] = files.map((f: any) => ({
            label: f.name,
            description: f.path,
            path: f.path
          }));

          const choice = await vscode.window.showQuickPick(fileChoices, {
            placeHolder: 'Select file to apply fix'
          });

          if (!choice) {
            this.addMessage({
              type: 'ai',
              content: `Fix not applied. Please select a file to apply the fix.`,
              timestamp: new Date(),
              suggestedPrompts: ['Connect to AWS for Better Experience', 'Paste More Logs']
            });
            return;
          }

          filePath = choice.path;
        } else {
          // Ask user to specify file path
          const input = await vscode.window.showInputBox({
            prompt: 'Enter the file path to apply the fix',
            placeHolder: 'src/main/java/com/example/Service.java'
          });

          if (!input) {
            this.addMessage({
              type: 'ai',
              content: `Fix not applied. Please specify a file path.`,
              timestamp: new Date(),
              suggestedPrompts: ['Connect to AWS for Better Experience', 'Paste More Logs']
            });
            return;
          }

          filePath = input;
        }

        explanation = this._lastInvestigationResult?.rootCause || 'RCA fix applied';
      } else if (fixData.filePath && fixData.code) {
        // Structured fix object
        filePath = fixData.filePath;
        newCode = fixData.code;
        explanation = fixData.explanation || 'RCA fix applied';
      } else {
        throw new Error('Invalid fix format');
      }

      if (!filePath) {
        throw new Error('No file path specified for fix');
      }

      // Apply the fix using the existing applyFix method
      await this.applyFix({
        filePath: filePath as string,
        newCode: newCode,
        explanation: explanation || 'RCA fix applied'
      });

      // Track fix application
      this._analytics?.trackFeatureUsage('rca', 'fix_applied');

    } catch (error: any) {
      console.error('[Tivra DebugMind] Failed to apply RCA fix:', error);
      this.addMessage({
        type: 'ai',
        content: `❌ **Failed to Apply Fix**\n\nError: ${error.message}\n\nYou can try:\n• Manually applying the fix\n• Pasting more logs for re-analysis`,
        timestamp: new Date(),
        suggestedPrompts: ['Connect to AWS for Better Experience', 'Paste More Logs']
      });
    }
  }

  private async triggerSREInvestigation() {
    console.log('[Tivra DebugMind] Triggering SRE Agent investigation');

    // Verify we have service context
    if (!this._conversationContext.service) {
      this.addMessage({
        type: 'ai',
        content: `⚠️ **No Service Context**\n\nPlease analyze a service first before triggering an investigation.`,
        timestamp: new Date()
      });
      return;
    }

    const service = this._conversationContext.service;

    // Build investigation message based on GitHub connection
    const hasGitHub = !!this._githubData || !!(await this.getGitHubRepoFromWorkspace());
    let investigationMsg = `🔍 **Starting Deep Investigation**\n\nTriggering SRE Agent to investigate **${service.name}**...\n\nThe agent will:\n• Analyze CloudWatch logs in detail\n`;

    if (hasGitHub) {
      investigationMsg += `• Review recent code changes from GitHub\n`;
      investigationMsg += `• Correlate deployment timing\n`;
    } else {
      investigationMsg += `• Analyze error patterns and frequency\n`;
      investigationMsg += `• Identify potential root causes\n`;
    }

    investigationMsg += `• Form and test hypotheses\n`;
    investigationMsg += `• Provide structured root cause analysis\n\n`;
    investigationMsg += `This may take 15-30 seconds...`;

    this.addMessage({
      type: 'ai',
      content: investigationMsg,
      timestamp: new Date(),
      isTyping: true
    });

    try {
      // Get GitHub context - prefer stored OAuth data over workspace detection
      let githubRepo: string | undefined;
      let githubToken: string | undefined;
      let branch: string | undefined;

      if (this._githubData) {
        // Use OAuth data if available
        githubRepo = `${this._githubData.owner}/${this._githubData.repo}`;
        githubToken = this._githubData.token;
        branch = this._githubData.baseBranch;
        console.log(`[Tivra DebugMind] Using OAuth GitHub data: ${githubRepo}`);
      } else {
        // Fall back to workspace detection
        githubRepo = await this.getGitHubRepoFromWorkspace();
        branch = await this.getCurrentBranch();
        console.log(`[Tivra DebugMind] Using workspace GitHub data: ${githubRepo || 'none'}`);
      }

      // Prepare investigation request with comprehensive context
      const investigationRequest = {
        service: {
          name: service.name,
          type: service.type,
          logGroupName: service.logGroupName,
          region: service.region || this._awsConnectionState?.region || 'us-east-1'
        },
        errors: this._conversationContext.recentErrors.map((error: any) => ({
          message: error.message || error.type || 'Unknown error',
          count: error.count || 1,
          timestamp: error.lastSeen || new Date().toISOString(),
          stackTrace: error.stackTrace || null,
          samples: error.samples || []
        })),
        // Include pre-fetched CloudWatch data to avoid redundant API calls
        cloudwatchData: this._errorAnalysisData ? {
          logs: this._errorAnalysisData.logs,
          fetchedAt: this._errorAnalysisData.timestamp
        } : null,
        context: {
          githubRepo: githubRepo,
          githubToken: githubToken,  // Include token for private repos
          branch: branch || 'main',
          workspace: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
          awsServices: this._awsServices.map(s => s.name),
          conversationHistory: this._conversationContext.conversationHistory.slice(-5) // Last 5 messages for context
        }
      };

      console.log('[Tivra DebugMind] Investigation request:', JSON.stringify(investigationRequest, null, 2));

      // Call SRE Agent via backend
      const response = await axios.post(
        `${this._apiUrl}/api/sre-agent/investigate`,
        investigationRequest,
        {
          timeout: 60000 // 60 second timeout
        }
      );

      console.log('[Tivra DebugMind] Investigation completed:', response.data.investigation_id);

      // Format the investigation results
      const investigation = response.data;

      // Store for "Explain the fix" handler
      this._lastInvestigationResult = investigation;

      let resultMessage = `## 🎯 Investigation Complete\n\n`;
      resultMessage += `**Session ID:** \`${investigation.session_id || investigation.investigation_id}\`\n`;
      resultMessage += `**Confidence:** ${((investigation.root_cause_confidence || investigation.confidence || 0) * 100).toFixed(0)}%\n\n`;

      // Root Cause (v2 format: string, or v1 format: object)
      if (investigation.root_cause) {
        resultMessage += `### 🔴 Root Cause\n\n`;

        if (typeof investigation.root_cause === 'string') {
          // v2 format: root_cause is a string
          resultMessage += `${investigation.root_cause}\n\n`;
        } else {
          // v1 format: root_cause is an object
          const rc = investigation.root_cause;
          resultMessage += `**Category:** ${rc.category?.replace('_', ' ').toUpperCase() || 'UNKNOWN'}\n`;
          resultMessage += `**Impact:** ${rc.impact?.toUpperCase() || 'UNKNOWN'}\n`;
          resultMessage += `**Confidence:** ${((rc.confidence || 0) * 100).toFixed(0)}%\n\n`;
          resultMessage += `**Description:**\n${rc.description || 'No description'}\n\n`;
        }
      }

      // Suggested Fix (v2 format: single fix, v1 format: array)
      if (investigation.suggested_fix) {
        // v2 format: single suggested_fix string
        resultMessage += `### 💡 Suggested Fix\n\n`;
        resultMessage += `**Type:** ${investigation.fix_type || 'Unknown'}\n`;
        resultMessage += `${investigation.suggested_fix}\n\n`;

        if (investigation.fix_file) {
          resultMessage += `**File:** \`${investigation.fix_file}\`\n`;
        }
        if (investigation.fix_code) {
          resultMessage += `\n**Code:**\n\`\`\`\n${investigation.fix_code}\n\`\`\`\n\n`;
        }
      } else if (investigation.suggested_fixes && investigation.suggested_fixes.length > 0) {
        // v1 format: array of suggested_fixes
        resultMessage += `### 💡 Suggested Fixes\n\n`;
        investigation.suggested_fixes.forEach((fix: any, idx: number) => {
          resultMessage += `**${idx + 1}. ${fix.type?.replace('_', ' ').toUpperCase() || 'FIX'}** (Risk: ${fix.risk_level || 'Unknown'}, Confidence: ${((fix.confidence || 0) * 100).toFixed(0)}%)\n`;
          resultMessage += `${fix.description || 'No description'}\n`;
          if (fix.estimated_time) {
            resultMessage += `*Estimated time: ${fix.estimated_time}*\n`;
          }
          resultMessage += '\n';
        });
      }

      // Evidence Summary (v2 format: object, v1 format: array)
      if (investigation.evidence) {
        if (Array.isArray(investigation.evidence)) {
          // v1 format: evidence is an array
          if (investigation.evidence.length > 0) {
            resultMessage += `### 📊 Evidence Gathered\n\n`;
            investigation.evidence.forEach((ev: any, idx: number) => {
              resultMessage += `${idx + 1}. **${ev.type?.toUpperCase() || 'EVIDENCE'}** - ${ev.description || 'No description'} (Confidence: ${((ev.confidence || 0) * 100).toFixed(0)}%)\n`;
            });
            resultMessage += '\n';
          }
        } else {
          // v2 format: evidence is an object with logs, metrics, code_diff, deployment
          resultMessage += `### 📊 Evidence Gathered\n\n`;

          if (investigation.evidence.logs && investigation.evidence.logs.length > 0) {
            resultMessage += `**Logs:** ${investigation.evidence.logs.length} error messages\n`;
          }
          if (investigation.evidence.code_diff) {
            resultMessage += `**Code:** ${investigation.evidence.code_diff.files?.length || 0} files analyzed\n`;
          }
          if (investigation.evidence.deployment) {
            resultMessage += `**Deployment:** Recent deployment detected\n`;
          }
          resultMessage += '\n';
        }
      }

      // Hypotheses (v2 format only)
      if (investigation.hypotheses && investigation.hypotheses.length > 0) {
        resultMessage += `### 🔬 Hypotheses\n\n`;
        investigation.hypotheses.forEach((hyp: any, idx: number) => {
          const status = hyp.status === 'verified' ? '✅' : hyp.status === 'rejected' ? '❌' : '⏳';
          resultMessage += `${idx + 1}. ${status} ${hyp.statement} (${((hyp.confidence || 0) * 100).toFixed(0)}%)\n`;
        });
        resultMessage += '\n';
      }

      // Reasoning Steps (collapsed) - v1 format only
      if (investigation.reasoning_steps && investigation.reasoning_steps.length > 0) {
        resultMessage += `<details>\n<summary>Investigation Steps (${investigation.reasoning_steps.length})</summary>\n\n`;
        investigation.reasoning_steps.forEach((step: string, idx: number) => {
          resultMessage += `${idx + 1}. ${step}\n`;
        });
        resultMessage += `</details>\n\n`;
      }

      // Update the message
      this.updateLastMessage({
        type: 'ai',
        content: resultMessage,
        timestamp: new Date()
      });

      // Store investigation results in context
      this._errorAnalysisData = investigation;

      // Show warnings if any
      if (investigation.warnings && investigation.warnings.length > 0) {
        this.addMessage({
          type: 'system',
          content: `**⚠️ System Warnings:**\n\n${investigation.warnings.map((w: string) => `• ${w}`).join('\n')}\n\nThese warnings indicate missing context that could improve investigation accuracy.`,
          timestamp: new Date()
        });
      }

      // Check if GitHub is connected - prompt if not
      await this.checkGitHubConnectionAfterInvestigation();

    } catch (error: any) {
      console.error('[Tivra DebugMind] Investigation failed:', error);

      let errorMessage = `❌ **Investigation Failed**\n\n`;

      if (error.code === 'ECONNREFUSED') {
        errorMessage += `Could not connect to SRE Agent service.\n\n`;
        errorMessage += `**Please ensure:**\n`;
        errorMessage += `• SRE Agent service is running on port 5001\n`;
        errorMessage += `• Run: \`cd tivra-copilot/sre-agent && python app.py\`\n`;
      } else if (error.response?.status === 503) {
        errorMessage += `SRE Agent service is unavailable.\n\n`;
        errorMessage += `${error.response?.data?.message || 'Service not responding'}\n`;
      } else {
        errorMessage += `${error.response?.data?.message || error.message}\n`;
      }

      this.updateLastMessage({
        type: 'ai',
        content: errorMessage,
        timestamp: new Date(),
        suggestedPrompts: [
          'Try again',
          'Analyze other services'
        ]
      });
    }
  }

  /**
   * Prompt user to provide log group name for a service
   */
  private async promptForLogGroup(serviceName: string) {
    this.addMessage({
      type: 'ai',
      content: `**Provide Log Group for ${serviceName}**\n\nPlease enter the CloudWatch Logs group name for this EC2 instance.\n\nExample log group names:\n• \`/aws/ec2/instance/${serviceName}\`\n• \`/var/log/application\`\n• Custom log group you configured\n\nYou can find log groups in the AWS Console under CloudWatch > Log groups.`,
      timestamp: new Date()
    });

    // Set state to wait for log group input
    this._awsConnectionState = {
      step: 'EC2_LOG_GROUP' as any,
      serviceName: serviceName
    } as any;
  }

  /**
   * Show CloudWatch agent setup instructions
   */
  private async showCloudWatchAgentInstructions() {
    const instructions = `**📖 How to Setup CloudWatch Agent for EC2**\n\n` +
      `To enable CloudWatch Logs for EC2 instances, you need to install and configure the CloudWatch agent:\n\n` +
      `**Step 1: Install CloudWatch Agent**\n` +
      `\`\`\`bash\n` +
      `# Download the agent (Amazon Linux 2)\n` +
      `wget https://s3.amazonaws.com/amazoncloudwatch-agent/amazon_linux/amd64/latest/amazon-cloudwatch-agent.rpm\n` +
      `sudo rpm -U ./amazon-cloudwatch-agent.rpm\n` +
      `\`\`\`\n\n` +
      `**Step 2: Create Configuration File**\n` +
      `Create \`/opt/aws/amazon-cloudwatch-agent/etc/config.json\`:\n` +
      `\`\`\`json\n` +
      `{\n` +
      `  "logs": {\n` +
      `    "logs_collected": {\n` +
      `      "files": {\n` +
      `        "collect_list": [\n` +
      `          {\n` +
      `            "file_path": "/var/log/application.log",\n` +
      `            "log_group_name": "/aws/ec2/your-instance-name",\n` +
      `            "log_stream_name": "{instance_id}"\n` +
      `          }\n` +
      `        ]\n` +
      `      }\n` +
      `    }\n` +
      `  }\n` +
      `}\n` +
      `\`\`\`\n\n` +
      `**Step 3: Start the Agent**\n` +
      `\`\`\`bash\n` +
      `sudo /opt/aws/amazon-cloudwatch-agent/bin/amazon-cloudwatch-agent-ctl \\\n` +
      `  -a fetch-config \\\n` +
      `  -m ec2 \\\n` +
      `  -s \\\n` +
      `  -c file:/opt/aws/amazon-cloudwatch-agent/etc/config.json\n` +
      `\`\`\`\n\n` +
      `**Step 4: Verify Logs in AWS Console**\n` +
      `• Go to CloudWatch Console\n` +
      `• Navigate to Log groups\n` +
      `• Look for your log group: \`/aws/ec2/your-instance-name\`\n\n` +
      `**IAM Permissions Required:**\n` +
      `Your EC2 instance needs an IAM role with these permissions:\n` +
      `• \`logs:CreateLogGroup\`\n` +
      `• \`logs:CreateLogStream\`\n` +
      `• \`logs:PutLogEvents\`\n\n` +
      `📚 **Full Documentation:** https://docs.aws.amazon.com/AmazonCloudWatch/latest/monitoring/Install-CloudWatch-Agent.html`;

    this.addMessage({
      type: 'ai',
      content: instructions,
      timestamp: new Date(),
      suggestedPrompts: [
        'I\'ve installed the agent, analyze again',
        'Skip EC2 log analysis',
        'Provide log group manually'
      ]
    });
  }



  /**
   * Analyze all services for errors
   */
  private async analyzeAllServices() {
    this.addMessage({
      type: 'system',
      content: '🔍 Analyzing all AWS services for errors...',
      timestamp: new Date()
    });

    try {
      // If no services discovered yet, fetch them first
      if (this._awsServices.length === 0) {
        const statusResponse = await axios.get(`${this._apiUrl}/api/aws/status`);
        const region = statusResponse.data?.account?.region || 'us-east-1';
        await this.fetchAWSServices(region);

        if (this._awsServices.length === 0) {
          this.addMessage({
            type: 'ai',
            content: `**No Services Found** ℹ️\n\nI couldn't find any AWS services in your account.\n\nPlease ensure you have services deployed and proper IAM permissions.`,
            timestamp: new Date()
          });
          return;
        }
      }

      let totalErrors = 0;
      let errorsByService: any[] = [];

      // Analyze each service for errors
      const servicesNeedingLogGroup: any[] = [];

      for (const service of this._awsServices) {
        try {
          const response = await axios.get(`${this._apiUrl}/api/aws/logs`, {
            params: {
              serviceName: service.name,
              serviceType: service.type
            }
          });

          if (response.data.errorCount > 0) {
            totalErrors += response.data.errorCount;
            errorsByService.push({
              service: service.name,
              type: service.type,
              errors: response.data.topErrors || [],
              count: response.data.errorCount
            });
          } else if (response.data.needsLogGroup) {
            // Service needs manual log group configuration
            servicesNeedingLogGroup.push({
              service: service.name,
              type: service.type,
              message: response.data.message
            });
          }
        } catch (error) {
          console.error(`Error analyzing ${service.name}:`, error);
        }
      }

      // Show info about services that need log group configuration
      if (servicesNeedingLogGroup.length > 0) {
        let configMessage = `**ℹ️ Configuration Needed**\n\n`;
        configMessage += `The following services could not be analyzed automatically:\n\n`;

        servicesNeedingLogGroup.forEach(svc => {
          configMessage += `**${svc.service}** (${svc.type})\n`;
          configMessage += `${svc.message}\n\n`;
        });

        configMessage += `**What would you like to do?**`;

        this.addMessage({
          type: 'ai',
          content: configMessage,
          timestamp: new Date(),
          suggestedPrompts: servicesNeedingLogGroup.map(svc =>
            `Provide log group for ${svc.service}`
          ).concat([
            'Skip EC2 log analysis',
            'How to setup CloudWatch agent for EC2'
          ])
        });

        // Store services needing configuration for later reference
        this._servicesNeedingLogGroup = servicesNeedingLogGroup;
      }

      // Display results
      if (totalErrors === 0 && servicesNeedingLogGroup.length === 0) {
        // No errors and all services analyzed successfully
        this.addMessage({
          type: 'ai',
          content: `**No Errors Found!** ✅\n\nAll your services are running smoothly with no errors in the last hour.\n\n**Services Analyzed:**\n${this._awsServices.map(s => `• ${s.name} (${s.type})`).join('\n')}\n\nEverything looks perfect! 🎉`,
          timestamp: new Date(),
          suggestedPrompts: [
            'Monitor for new errors',
            'Check service metrics',
            'Show service status'
          ]
        });
      } else if (totalErrors === 0 && servicesNeedingLogGroup.length > 0) {
        // No errors in services that were analyzed, but some need config
        const analyzedServices = this._awsServices.filter(s =>
          !servicesNeedingLogGroup.some(needsConfig => needsConfig.service === s.name)
        );

        if (analyzedServices.length > 0) {
          this.addMessage({
            type: 'ai',
            content: `**No Errors Found!** ✅\n\nThe following services are running smoothly with no errors:\n\n${analyzedServices.map(s => `• ${s.name} (${s.type})`).join('\n')}\n\nNote: Some services need additional configuration to be analyzed.`,
            timestamp: new Date()
          });
        }
      } else {
        // Build error summary
        let errorMessage = `**Errors Found** ⚠️\n\nFound ${totalErrors} error(s) across ${errorsByService.length} service(s) in the last hour.\n\n`;

        errorsByService.forEach(svc => {
          errorMessage += `### ${svc.service} (${svc.type})\n`;
          errorMessage += `**${svc.count} error(s)**\n\n`;

          // Show first 2 errors for each service
          svc.errors.slice(0, 2).forEach((err: any, i: number) => {
            errorMessage += `${i + 1}. ${err.message || 'Unknown error'}\n`;
            if (err.timestamp) {
              errorMessage += `   _${new Date(err.timestamp).toLocaleString()}_\n`;
            }
          });
          errorMessage += '\n';
        });

        errorMessage += `\n**Generating RCA and fix...**`;

        this.addMessage({
          type: 'ai',
          content: errorMessage,
          timestamp: new Date()
        });

        // Call Claude for RCA
        const firstError = errorsByService[0];
        const rcaResponse = await axios.post(`${this._apiUrl}/api/chat`, {
          message: `Analyze these errors and provide root cause analysis with fixes:\n\nService: ${firstError.service}\nType: ${firstError.type}\nErrors: ${JSON.stringify(firstError.errors.slice(0, 3), null, 2)}`,
          context: {
            recentErrors: firstError.errors,
            connectedServices: this._awsServices.map(s => s.name),
            conversationHistory: []
          }
        });

        const { response, suggestedFix } = rcaResponse.data;

        this.addMessage({
          type: 'ai',
          content: `## 🔍 Root Cause Analysis\n\n${response}`,
          timestamp: new Date(),
          suggestedFix: suggestedFix,
          suggestedPrompts: [
            'Create a PR with the fix',
            'Show more error details',
            'Check related services'
          ]
        });

        // Store errors in context
        this._conversationContext.recentErrors = errorsByService.flatMap(s => s.errors);
      }

    } catch (error: any) {
      console.error('Error analyzing services:', error);
      this.addMessage({
        type: 'ai',
        content: `❌ **Analysis Failed**\n\nError: ${error.response?.data?.error || error.message}\n\nPlease try again or check individual services manually.`,
        timestamp: new Date()
      });
    }
  }


  /**
   * Stop autonomous monitoring (agent-side)
   */
  private async stopAutonomousMonitoring() {
    if (!this._autonomousMonitoringActive) {
      return;
    }

    try {
      // Call agent to stop monitoring
      const services = this._awsServices.filter(s => s.logGroupName || s.logGroup);
      for (const service of services) {
        await axios.post(`${this._apiUrl}/api/sre-agent/stop-monitoring`, {
          service_name: service.name
        });
      }

      this._autonomousMonitoringActive = false;
      this._isMonitoring = false;

      console.log('[Tivra DebugMind] Autonomous monitoring stopped');
    } catch (error: any) {
      console.error('[Tivra DebugMind] Failed to stop autonomous monitoring:', error);
    }
  }

  /**
   * Analyze service errors and start debugging conversation
   */
  public async startDebugging(serviceName: string, serviceType: string) {
    this._conversationContext.service = { name: serviceName, type: serviceType };

    this.addMessage({
      type: 'system',
      content: `🔍 Analyzing errors in **${serviceName}**...`,
      timestamp: new Date()
    });

    try {
      // Fetch error logs from backend
      const response = await axios.post(`${this._apiUrl}/api/aws/logs/analyze`, {
        serviceName,
        serviceType,
        timeRange: {
          start: Date.now() - 60 * 60 * 1000,
          end: Date.now()
        }
      });

      const analysis = response.data;
      this._conversationContext.recentErrors = analysis.errors || [];

      if (analysis.totalErrors === 0) {
        this.addMessage({
          type: 'ai',
          content: `✅ Good news! No errors found in **${serviceName}** in the last hour.\n\nEverything looks healthy. Let me know if you want to:\n- Check a different time range\n- Monitor another service\n- Analyze warnings`,
          timestamp: new Date()
        });
        return;
      }

      // AI analyzes the errors and starts conversation
      await this.analyzeErrorsWithAI(analysis);

    } catch (error: any) {
      this.addMessage({
        type: 'system',
        content: `❌ Failed to analyze ${serviceName}: ${error.message}`,
        timestamp: new Date()
      });
    }
  }

  /**
   * AI analyzes errors and suggests fixes conversationally
   */
  private async analyzeErrorsWithAI(analysis: any) {
    // Add AI's initial analysis
    this.addMessage({
      type: 'ai',
      content: `I found **${analysis.totalErrors} error(s)** in **${this._conversationContext.service?.name}**. Let me analyze them...`,
      timestamp: new Date(),
      isTyping: true
    });

    try {
      // Call backend AI to get intelligent summary and fix
      const aiResponse = await axios.post(`${this._apiUrl}/api/ai/analyze-errors`, {
        service: this._conversationContext.service,
        errors: this._conversationContext.recentErrors,
        conversationHistory: this._conversationContext.conversationHistory
      });

      const { summary, rootCause, suggestedFix, confidence } = aiResponse.data;

      // Update with AI's analysis
      this.updateLastMessage({
        type: 'ai',
        content: this.formatAIAnalysis(summary, rootCause, confidence),
        timestamp: new Date(),
        suggestedFix: suggestedFix
      });

      // Add to conversation history
      this._conversationContext.conversationHistory.push({
        role: 'assistant',
        content: summary
      });

    } catch (error: any) {
      this.updateLastMessage({
        type: 'ai',
        content: `I analyzed the errors. Here's what I found:\n\n${this.formatSimpleAnalysis(analysis)}`,
        timestamp: new Date()
      });
    }
  }

  /**
   * Format AI's analysis in a conversational way
   */
  private formatAIAnalysis(summary: string, rootCause: string, confidence: string): string {
    let message = `## 🔍 Analysis Complete\n\n`;
    message += `${summary}\n\n`;
    message += `**Root Cause**: ${rootCause}\n\n`;
    message += `**Confidence**: ${confidence}\n\n`;
    message += `💡 I can generate a fix for this. Would you like me to:\n`;
    message += `1. Show you the proposed code changes\n`;
    message += `2. Explain the error in more detail\n`;
    message += `3. Check for similar issues in other services`;
    return message;
  }

  /**
   * Format simple analysis when AI endpoint unavailable
   */
  private formatSimpleAnalysis(analysis: any): string {
    let message = `Found ${analysis.totalErrors} error(s):\n\n`;

    analysis.errors.slice(0, 3).forEach((error: any, i: number) => {
      message += `**${i + 1}. ${error.message}**\n`;
      message += `- Occurred: ${error.count || 1} time(s)\n`;
      message += `- Last seen: ${new Date(error.timestamp).toLocaleTimeString()}\n\n`;
    });

    if (analysis.totalErrors > 3) {
      message += `_...and ${analysis.totalErrors - 3} more errors_\n\n`;
    }

    message += `How can I help you debug this?`;
    return message;
  }

  /**
   * Handle user's message in the chat
   */
  private async handleUserMessage(text: string) {
    // Add user message
    this.addMessage({
      type: 'user',
      content: text,
      timestamp: new Date()
    });

    // Add to conversation history
    this._conversationContext.conversationHistory.push({
      role: 'user',
      content: text
    });

    // NEW RCA FLOW: Check if user pasted error logs
    const logParser = new LocalLogParser();
    const validation = logParser.validate(text);

    const textPreview = text.substring(0, 200).replace(/\n/g, ' ');
    console.log('[Tivra DebugMind] Validating text:', textPreview);
    console.log('[Tivra DebugMind] Text length:', text.length, 'lines:', text.split('\n').length);
    console.log('[Tivra DebugMind] Log validation result:', validation);

    if (validation.valid) {
      // User pasted logs - trigger RCA flow
      console.log('[Tivra DebugMind] Valid logs detected, triggering RCA flow');
      await this.handleRCAFlow(text);
      return;
    } else if (validation.error) {
      // User tried to paste logs but validation failed
      // Show error if text looks like logs (multiple lines, timestamps, or log level keywords)
      const lines = text.split('\n').filter(l => l.trim().length > 0);
      const looksLikeLogs = lines.length >= 2 ||
                           /\d{4}-\d{2}-\d{2}|\d{2}:\d{2}:\d{2}|INFO|WARN|DEBUG|TRACE|ERROR|FATAL|Exception|at\s+[\w.]+\(|File\s+"[^"]+"/i.test(text);

      console.log('[Tivra DebugMind] Validation failed. Lines:', lines.length, 'Looks like logs:', looksLikeLogs, 'Error:', validation.error);

      if (looksLikeLogs) {
        this.addMessage({
          type: 'ai',
          content: `⚠️ **Log Validation Failed**\n\n${validation.error}\n\n**Requirements:**\n• At least 5 lines of logs\n• Must contain error keywords (ERROR, FATAL, CRITICAL, SEVERE, Exception)\n\n**Supported formats:**\n• Java/Spring Boot logs\n• Python logs\n• Node.js logs\n• CloudWatch logs\n\n**Example:**\n\`\`\`\n2025-01-15 10:30:45 ERROR [app] NullPointerException\n  at com.example.Service.method(Service.java:42)\n  ...\n\`\`\`\n\n*Please paste valid error logs with at least 5 lines.*`,
          timestamp: new Date()
        });
        return;
      }
    }

    // Check if we're in AWS credential input flow
    if (this._awsConnectionState) {
      const handled = await this.handleAWSCredentialInput(text);
      if (handled) return;
    }

    const lowerText = text.toLowerCase();

    // Handle terminal state prompts from fix application
    if (lowerText.includes('create') && lowerText.includes('github') && lowerText.includes('pr')) {
      this.showCreatePRInfo();
      return;
    }

    if (lowerText.includes('monitor') && lowerText.includes('deployment')) {
      this.showMonitorDeploymentInfo();
      return;
    }

    if (lowerText.includes('save') && lowerText.includes('root cause')) {
      this.showSaveRootCauseInfo();
      return;
    }

    if (lowerText.includes('check') && lowerText.includes('similar') && lowerText.includes('issues')) {
      this.showSimilarIssuesInfo();
      return;
    }

    // NEW RCA FLOW: Check if user wants to apply the fix from RCA
    if (lowerText === 'apply fix' && this._lastInvestigationResult?.fix) {
      await this.applyRCAFix(this._lastInvestigationResult.fix);
      return;
    }

    // Check if user is providing log group for EC2
    if (lowerText.includes('provide log group')) {
      const match = text.match(/provide log group for (\S+)/i);
      if (match && match[1]) {
        const serviceName = match[1];
        await this.promptForLogGroup(serviceName);
        return;
      }
    }

    // Check if user wants to skip EC2 analysis
    if (lowerText.includes('skip') && (lowerText.includes('ec2') || lowerText.includes('log analysis'))) {
      this.addMessage({
        type: 'ai',
        content: `✅ **Skipped EC2 Log Analysis**\n\nEC2 instances will be excluded from log analysis. You can still analyze other services.\n\nIf you change your mind, just ask me to "Analyze EC2 logs" and provide the log group name.`,
        timestamp: new Date()
      });
      this._servicesNeedingLogGroup = []; // Clear the list
      return;
    }

    // Check if user wants CloudWatch agent setup instructions
    if (lowerText.includes('setup cloudwatch') || lowerText.includes('install cloudwatch') ||
        (lowerText.includes('how to') && lowerText.includes('cloudwatch agent'))) {
      await this.showCloudWatchAgentInstructions();
      return;
    }

    // Check if user wants to start autonomous monitoring
    if ((lowerText.includes('start') || lowerText.includes('enable')) &&
        (lowerText.includes('real-time') || lowerText.includes('realtime') ||
         lowerText.includes('live') || lowerText.includes('continuous') ||
         lowerText.includes('monitor') || lowerText.includes('autonomous'))) {
      if (this._awsServices.length > 0) {
        await this.startAutonomousMonitoring(this._awsServices);
        return;
      } else {
        this.addMessage({
          type: 'ai',
          content: `⚠️ **No Services Discovered**\n\nPlease discover your AWS services first by asking me to "analyze my AWS services" or "connect to AWS".`,
          timestamp: new Date()
        });
        return;
      }
    }

    // Check if user wants to stop autonomous monitoring
    if ((lowerText.includes('stop') || lowerText.includes('disable')) &&
        (lowerText.includes('monitor') || lowerText.includes('real-time') ||
         lowerText.includes('realtime') || lowerText.includes('live') || lowerText.includes('autonomous'))) {
      await this.stopAutonomousMonitoring();
      this.addMessage({
        type: 'ai',
        content: `✅ **Autonomous monitoring stopped**\n\nYou can restart monitoring anytime by asking me to "start monitoring".`,
        timestamp: new Date()
      });
      return;
    }

    // Check if user wants to disconnect from AWS
    if ((lowerText.includes('disconnect') || lowerText.includes('logout') || lowerText.includes('reset')) &&
        lowerText.includes('aws')) {
      await this.disconnectFromAWS();
      return;
    }

    // Check if user wants to connect to AWS
    if (lowerText.includes('connect') && lowerText.includes('aws')) {
      // Start manual keys flow
      this.startManualKeysFlow();
      return;
    }

    // Check if user wants to connect GitHub
    if (lowerText.includes('connect github') || lowerText.includes('connect to github')) {
      await this.startGitHubOAuth();
      return;
    }

    // Check if user wants to retry GitHub connection
    if (lowerText.includes('retry github') || lowerText.includes('check github status')) {
      await this.checkGitHubConnection();
      return;
    }

    // Check if user wants detailed error explanation
    if (lowerText.includes('explain') && lowerText.includes('error')) {
      await this.explainErrors();
      return;
    }

    // Check if user wants to start investigation directly
    if ((lowerText.includes('start') && lowerText.includes('investigation')) ||
        lowerText === 'investigate') {
      this.addMessage({
        type: 'system',
        content: `🤖 Starting unified investigation with SRE Agent...`,
        timestamp: new Date()
      });
      await this.triggerSREInvestigation();
      return;
    }

    // Check if user is providing feedback rating
    if (this._pendingFeedbackSessionId && (text.includes('/5') || lowerText.includes('excellent') || lowerText.includes('good') || lowerText.includes('okay') || lowerText.includes('poor'))) {
      await this.handleFeedbackRating(text);
      return;
    }

    // Check if user wants to skip feedback
    if (this._pendingFeedbackSessionId && lowerText.includes('skip feedback')) {
      this._pendingFeedbackSessionId = null;
      this.addMessage({
        type: 'ai',
        content: `No problem! You can always provide feedback later.`,
        timestamp: new Date(),
        suggestedPrompts: [
          'Monitor new errors',
          'Analyze another service'
        ]
      });
      return;
    }

    // Check if user wants to skip
    if ((lowerText.includes('skip') && !lowerText.includes('investigate')) ||
        lowerText.includes('skip for now')) {
      this.addMessage({
        type: 'ai',
        content: `⏭️ **Skipped**\n\nNo problem! You can investigate these errors later, or I can monitor for new errors.`,
        timestamp: new Date(),
        suggestedPrompts: [
          'Monitor new errors',
          'Analyze another service',
          'Start investigation'
        ]
      });
      return;
    }

    // Check if user wants to skip GitHub and proceed with investigation
    if ((lowerText.includes('skip') && lowerText.includes('investigate')) ||
        lowerText.includes('investigate without github')) {
      this.addMessage({
        type: 'system',
        content: `🤖 Starting investigation without GitHub context...`,
        timestamp: new Date()
      });
      await this.triggerSREInvestigation();
      return;
    }

    // Check if user wants to investigate again (after validation/deployment)
    if (lowerText.includes('investigate again') ||
        (lowerText.includes('investigate') && lowerText.includes('again'))) {
      if (this._conversationContext.service) {
        this.addMessage({
          type: 'system',
          content: `🔄 Starting new investigation for ${this._conversationContext.service.name}...`,
          timestamp: new Date()
        });
        await this.triggerSREInvestigation();
      } else {
        this.addMessage({
          type: 'ai',
          content: `⚠️ **No Service Context**\n\nI don't have a service to investigate. Please analyze your AWS services first.`,
          timestamp: new Date(),
          suggestedPrompts: ['Analyze my AWS services']
        });
      }
      return;
    }

    // Check if user wants to monitor new errors (exit current flow and start autonomous monitoring)
    if ((lowerText.includes('monitor') && lowerText.includes('new')) ||
        lowerText.includes('monitor new errors') ||
        lowerText.includes('check for new errors')) {
      // Auto-start autonomous monitoring
      if (this._awsServices.length > 0) {
        await this.startAutonomousMonitoring(this._awsServices);
      } else {
        this.addMessage({
          type: 'ai',
          content: `⚠️ **No Services Available**\n\nPlease analyze your AWS services first, then I can start monitoring.`,
          timestamp: new Date(),
          suggestedPrompts: ['Analyze my AWS services']
        });
      }
      return;
    }

    // Check if user wants to explain the fix
    if (lowerText.includes('explain') && (lowerText.includes('fix') || lowerText.includes('solution'))) {
      await this.explainLastFix();
      return;
    }

    // Check if user wants to approve and create PR
    if ((lowerText.includes('approve') && lowerText.includes('pr')) ||
        (lowerText.includes('approve') && lowerText.includes('fix')) ||
        lowerText.includes('create a pr') ||
        lowerText.includes('create pr') ||
        lowerText.includes('try again')) {
      await this.approveAndCreatePR();
      return;
    }

    // Check if user wants to validate deployment
    if ((lowerText.includes('validate') && lowerText.includes('deployment')) ||
        (lowerText.includes('check') && lowerText.includes('errors')) ||
        (lowerText.includes('verify') && lowerText.includes('fix')) ||
        (lowerText.includes('deployed') && (lowerText.includes('fix') || lowerText.includes('pr'))) ||
        lowerText.includes('fix has been deployed') ||
        lowerText.includes('deployment is complete') ||
        lowerText.includes('i deployed')) {
      await this.validateDeployment();
      return;
    }

    // Check if user wants to skip GitHub (general)
    if (lowerText.includes('skip for now') || lowerText.includes('skip github') ||
        (lowerText.includes('skip') && lowerText.includes('connect'))) {
      this.addMessage({
        type: 'system',
        content: `🤖 Proceeding with investigation (without GitHub context)...`,
        timestamp: new Date()
      });
      await this.triggerSREInvestigation();
      return;
    }

    // Check if user is choosing authentication method
    const usesAccessKeys = lowerText.includes('access key') ||
                          (lowerText.includes('use') && lowerText.includes('key'));
    // TODO: SSO flow - fix later
    // const usesSSO = lowerText.includes('sso') ||
    //                (lowerText.includes('use') && lowerText.includes('sso'));

    if (usesAccessKeys) {
      // Check if already connected
      try {
        const statusResponse = await axios.get(`${this._apiUrl}/api/aws/status`);
        if (statusResponse.data?.connected) {
          this.addMessage({
            type: 'ai',
            content: `✅ You're already connected to AWS!\n\nYour AWS credentials are configured and ready to use.\n\n**What would you like to do?**\n\n• Analyze errors in a service\n• Check CloudWatch logs\n• Debug a specific issue\n\nJust ask me and I'll help!`,
            timestamp: new Date(),
            suggestedPrompts: [
              'Show me recent errors in my services',
              'Analyze Lambda function failures',
              'Help me debug a timeout issue'
            ]
          });
          return;
        }
      } catch (error) {
        // Continue with connection flow
      }

      // Start manual keys flow directly
      this.startManualKeysFlow();
      return;
    }

    // TODO: SSO flow - fix later
    // if (usesSSO) {
    //   // Check if already connected
    //   try {
    //     const statusResponse = await axios.get(`${this._apiUrl}/api/aws/status`);
    //     if (statusResponse.data?.connected) {
    //       this.addMessage({
    //         type: 'ai',
    //         content: `✅ You're already connected to AWS!\n\nYour AWS credentials are configured and ready to use.\n\n**What would you like to do?**\n\n• Analyze errors in a service\n• Check CloudWatch logs\n• Debug a specific issue\n\nJust ask me and I'll help!`,
    //         timestamp: new Date(),
    //         suggestedPrompts: [
    //           'Show me recent errors in my services',
    //           'Analyze Lambda function failures',
    //           'Help me debug a timeout issue'
    //         ]
    //       });
    //       return;
    //     }
    //   } catch (error) {
    //     // Continue with connection flow
    //   }

    //   // Start SSO flow directly
    //   await this.startSSOFlow();
    //   return;
    // }

    // DISABLED: AWS connection check - RCA flow doesn't require AWS connection
    // Before processing any other prompt, verify AWS connection
    // try {
    //   const statusResponse = await axios.get(`${this._apiUrl}/api/aws/status`);
    //   if (!statusResponse.data?.connected) {
    //     this.addMessage({
    //       type: 'ai',
    //       content: `⚠️ **AWS Not Connected**\n\nTo analyze logs and debug AWS services, I need to connect to your AWS account first.\n\n**Connect to AWS** 🔗\n\nChoose your authentication method:`,
    //       timestamp: new Date(),
    //       suggestedPrompts: [
    //         'Use Access Keys',
    //         // 'Use SSO' // TODO: fix later
    //         'Use Access Keys'
    //       ]
    //     });
    //     return;
    //   }
    // } catch (error) {
    //   this.addMessage({
    //     type: 'ai',
    //     content: `⚠️ **Unable to verify AWS connection**\n\nI couldn't check your AWS connection status. Please make sure:\n\n1. Backend server is running\n2. You're connected to the internet\n\n**Connect to AWS** 🔗\n\nChoose your authentication method:`,
    //     timestamp: new Date(),
    //     suggestedPrompts: [
    //       'Use Access Keys',
    //       'Use SSO'
    //     ]
    //   });
    //   return;
    // }

    // Check if user clicked "Trigger Investigation" button
    if (lowerText === 'trigger investigation') {
      await this.triggerSREInvestigation();
      return;
    }

    // Check if user is asking to analyze errors
    const analyzeKeywords = ['analyze', 'error', 'show', 'check', 'debug', 'find'];
    const isAnalyzeRequest = analyzeKeywords.some(keyword => lowerText.includes(keyword)) &&
                             (lowerText.includes('error') || lowerText.includes('service') || lowerText.includes('log'));

    if (isAnalyzeRequest) {
      // Guide user to paste logs for RCA
      this.addMessage({
        type: 'ai',
        content: `To analyze errors, please **paste your error logs** in the chat.\n\nI can analyze:\n• Java/Spring Boot logs\n• Python logs\n• Node.js logs\n• CloudWatch logs\n• Any text-based error logs\n\n*Just paste your logs below and I'll automatically detect errors and perform RCA.*`,
        timestamp: new Date()
      });
      return;
    }

    // If nothing matches, provide helpful RCA guidance
    this.addMessage({
      type: 'ai',
      content: `I'm here to help you debug! 🐛\n\n**To get started:**\nPaste your error logs below and I'll automatically:\n• Detect error patterns\n• Scan your workspace for relevant files\n• Perform root cause analysis\n• Suggest fixes\n\n*What error logs would you like me to analyze?*`,
      timestamp: new Date()
    });
  }

  /**
   * Generate fallback response when AI unavailable
   */
  private generateFallbackResponse(userMessage: string): string {
    const lowerMessage = userMessage.toLowerCase();

    if (lowerMessage.includes('fix') || lowerMessage.includes('solve')) {
      return `I can help you fix this! Let me analyze the errors and generate a code fix. Give me a moment... 🔧`;
    }

    if (lowerMessage.includes('why') || lowerMessage.includes('cause')) {
      return `Based on the error logs, this appears to be related to the errors I showed earlier. Would you like me to dive deeper into the root cause?`;
    }

    if (lowerMessage.includes('show') || lowerMessage.includes('code')) {
      return `I can show you the relevant code sections. Which error would you like to investigate first?`;
    }

    return `I understand. Let me help you with that. Based on the errors I found, what would you like to focus on first?`;
  }

  /**
   * Apply code fix to the workspace
   */
  private async applyFix(fix: CodeFix) {
    try {
      const uri = vscode.Uri.file(fix.filePath);

      // Check if file exists
      let document: vscode.TextDocument;
      try {
        document = await vscode.workspace.openTextDocument(uri);
      } catch {
        // Create file if doesn't exist
        const workspaceEdit = new vscode.WorkspaceEdit();
        workspaceEdit.createFile(uri, { ignoreIfExists: true });
        await vscode.workspace.applyEdit(workspaceEdit);
        document = await vscode.workspace.openTextDocument(uri);
      }

      // Show diff preview
      const tempUri = vscode.Uri.parse(`untitled:${fix.filePath}.proposed`);
      const tempDoc = await vscode.workspace.openTextDocument(tempUri);
      const edit = new vscode.WorkspaceEdit();
      edit.insert(tempUri, new vscode.Position(0, 0), fix.newCode);
      await vscode.workspace.applyEdit(edit);

      // Show side-by-side diff
      await vscode.commands.executeCommand(
        'vscode.diff',
        uri,
        tempUri,
        `${fix.filePath.split('/').pop()} - Proposed Fix`
      );

      // Ask for confirmation
      const choice = await vscode.window.showInformationMessage(
        `Apply fix to ${fix.filePath}?`,
        'Apply', 'Cancel'
      );

      if (choice === 'Apply') {
        // Apply the fix
        const fullRange = new vscode.Range(
          document.positionAt(0),
          document.positionAt(document.getText().length)
        );
        const finalEdit = new vscode.WorkspaceEdit();
        finalEdit.replace(uri, fullRange, fix.newCode);
        const success = await vscode.workspace.applyEdit(finalEdit);

        if (success) {
          await document.save();

          // Track applied fix
          this._conversationContext.appliedFixes.push({
            filePath: fix.filePath,
            code: fix.newCode,
            description: fix.explanation || 'Code fix applied',
            timestamp: new Date()
          });

          this.addMessage({
            type: 'system',
            content: `✅ Fix applied to **${fix.filePath}**`,
            timestamp: new Date()
          });

          this.addMessage({
            type: 'ai',
            content: `Great! I've applied the fix. The changes should:\n\n${fix.explanation}`,
            timestamp: new Date()
          });

          // Add terminal state message with next steps
          setTimeout(() => {
            this.addMessage({
              type: 'ai',
              content: `## ✅ **Fix Applied - What's Next?**\n\n` +
                `**Recommended Next Steps:**\n\n` +
                `1️⃣ **Deploy & Monitor** - Push to production and watch CloudWatch\n` +
                `2️⃣ **Create PR** - Document this fix for your team\n` +
                `3️⃣ **Verify Impact** - Check if error rate decreased\n` +
                `4️⃣ **Root Cause Learning** - Store this in the knowledge base\n\n` +
                `**What I Can Help With:**\n` +
                `• 📊 Monitor deployment for errors\n` +
                `• 🎯 Create GitHub PR with this fix\n` +
                `• 🔄 Set up auto-rollback if issues persist\n` +
                `• 📝 Document root cause for future reference\n` +
                `• 🤖 Similar issue detection across services\n\n` +
                `**Or continue debugging** by pasting more logs!`,
              timestamp: new Date(),
              suggestedPrompts: [
                'Create GitHub PR',
                'Monitor Deployment',
                'Save Root Cause',
                'Check Similar Issues',
                'Paste More Logs'
              ]
            });
          }, 1500);
        }
      } else {
        this.addMessage({
          type: 'system',
          content: `Fix not applied.`,
          timestamp: new Date()
        });
      }

    } catch (error: any) {
      this.addMessage({
        type: 'system',
        content: `❌ Failed to apply fix: ${error.message}`,
        timestamp: new Date()
      });
    }
  }

  private showCreatePRInfo() {
    this.addMessage({
      type: 'ai',
      content: `## 🎯 **Create GitHub PR with Fix**\n\n` +
        `I can help you create a GitHub Pull Request with:\n\n` +
        `✅ **Automatic PR Creation**:\n` +
        `• Commit the fix with detailed message\n` +
        `• Push to a new branch\n` +
        `• Create PR with RCA summary\n` +
        `• Include root cause analysis\n` +
        `• Add before/after comparison\n\n` +
        `✅ **PR Description Includes**:\n` +
        `• Error description and impact\n` +
        `• Root cause identified\n` +
        `• Fix explanation\n` +
        `• Testing recommendations\n` +
        `• Deployment notes\n\n` +
        `**To create a PR**, make sure:\n` +
        `1. Git repository is initialized\n` +
        `2. GitHub credentials are configured\n` +
        `3. You have push permissions\n\n` +
        `Then just ask: "Create PR for this fix"`,
      timestamp: new Date(),
      suggestedPrompts: ['Monitor Deployment', 'Paste More Logs']
    });
  }

  private showMonitorDeploymentInfo() {
    this.addMessage({
      type: 'ai',
      content: `## 📊 **Monitor Deployment**\n\n` +
        `After deploying your fix, I can help you monitor it:\n\n` +
        `✅ **Real-Time Monitoring**:\n` +
        `• Watch CloudWatch logs for the error pattern\n` +
        `• Track error rate changes\n` +
        `• Alert if issues persist\n` +
        `• Compare pre/post deployment metrics\n\n` +
        `✅ **Auto-Rollback**:\n` +
        `• Detect if error rate increases\n` +
        `• Automatically trigger rollback\n` +
        `• Notify team of rollback\n\n` +
        `✅ **Success Verification**:\n` +
        `• Confirm error stopped occurring\n` +
        `• Validate service health\n` +
        `• Generate success report\n\n` +
        `**To start monitoring**, deploy your fix and ask:\n` +
        `"Monitor deployment for [service-name]"`,
      timestamp: new Date(),
      suggestedPrompts: ['Create GitHub PR', 'Paste More Logs']
    });
  }

  private showSaveRootCauseInfo() {
    this.addMessage({
      type: 'ai',
      content: `## 💾 **Save Root Cause to Knowledge Base**\n\n` +
        `Store this root cause analysis for future reference:\n\n` +
        `✅ **What Gets Saved**:\n` +
        `• Error pattern and symptoms\n` +
        `• Root cause analysis\n` +
        `• Fix that was applied\n` +
        `• Code context\n` +
        `• Deployment info\n\n` +
        `✅ **Benefits**:\n` +
        `• **Faster future debugging** - Similar errors auto-detected\n` +
        `• **Team learning** - Share knowledge across engineers\n` +
        `• **Pattern detection** - Identify recurring issues\n` +
        `• **Automated suggestions** - Get fix recommendations\n\n` +
        `✅ **Powered by Pinecone**:\n` +
        `• Vector database for semantic search\n` +
        `• Find similar issues even with different wording\n` +
        `• Learn from past incidents\n\n` +
        `**To save**, just ask:\n` +
        `"Save this root cause to knowledge base"`,
      timestamp: new Date(),
      suggestedPrompts: ['Check Similar Issues', 'Paste More Logs']
    });
  }

  private showSimilarIssuesInfo() {
    this.addMessage({
      type: 'ai',
      content: `## 🤖 **Check for Similar Issues**\n\n` +
        `I can search for similar issues across your services:\n\n` +
        `✅ **Cross-Service Analysis**:\n` +
        `• Scan all AWS services\n` +
        `• Detect same error pattern\n` +
        `• Identify affected services\n` +
        `• Bulk fix recommendations\n\n` +
        `✅ **Pattern Matching**:\n` +
        `• Same root cause\n` +
        `• Similar code patterns\n` +
        `• Related deployment issues\n` +
        `• Dependency conflicts\n\n` +
        `✅ **Proactive Prevention**:\n` +
        `• Fix issues before they cause outages\n` +
        `• Apply learnings across codebase\n` +
        `• Prevent cascading failures\n\n` +
        `**To check**, ask:\n` +
        `"Check for similar issues across services"`,
      timestamp: new Date(),
      suggestedPrompts: ['Save Root Cause', 'Paste More Logs']
    });
  }

  /**
   * Handle when user rejects a fix
   */
  private handleFixRejection(reason?: string) {
    this.addMessage({
      type: 'ai',
      content: `I understand. ${reason ? `You mentioned: "${reason}". ` : ''}Let me suggest an alternative approach. What would you prefer?\n\n1. A different implementation\n2. More explanation about the issue\n3. Break down the fix into smaller steps`,
      timestamp: new Date()
    });
  }

  private addMessage(message: ChatMessage) {
    this._messages.push(message);
    this._updateWebview();
  }

  private updateLastMessage(message: ChatMessage) {
    if (this._messages.length > 0) {
      this._messages[this._messages.length - 1] = message;
      this._updateWebview();
    }
  }

  private _updateWebview() {
    this._panel.webview.postMessage({
      type: 'update',
      messages: this._messages
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
  <title>Tivra DebugMind</title>
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
      background: linear-gradient(135deg, #1e90ff 0%, #0066cc 100%);
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

    .status { font-size: 12px; opacity: 0.9; }

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
      background: linear-gradient(135deg, #1e90ff 0%, #0066cc 100%);
      color: white;
      align-self: flex-end;
    }

    .message.ai {
      background-color: var(--vscode-editor-selectionBackground);
      align-self: flex-start;
      border-left: 3px solid #1e90ff;
    }

    .message.system {
      background-color: var(--vscode-inputValidation-infoBackground);
      align-self: center;
      font-size: 13px;
      text-align: center;
      max-width: 60%;
      border-radius: 20px;
    }

    .message-header {
      display: flex;
      align-items: center;
      gap: 8px;
      margin-bottom: 10px;
      font-size: 12px;
      font-weight: 600;
      opacity: 0.8;
    }

    .message-content {
      line-height: 1.6;
      font-size: 14px;
    }

    .message-content h2 { font-size: 16px; margin: 12px 0 8px; }
    .message-content h3 { font-size: 14px; margin: 10px 0 6px; }
    .message-content strong { font-weight: 600; }
    .message-content code {
      background-color: rgba(0,0,0,0.1);
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

    .typing-indicator {
      display: inline-flex;
      gap: 4px;
      align-items: center;
    }

    .typing-indicator span {
      width: 8px;
      height: 8px;
      background-color: #1e90ff;
      border-radius: 50%;
      animation: bounce 1.4s infinite;
    }

    .typing-indicator span:nth-child(2) { animation-delay: 0.2s; }
    .typing-indicator span:nth-child(3) { animation-delay: 0.4s; }

    @keyframes bounce {
      0%, 60%, 100% { transform: translateY(0); }
      30% { transform: translateY(-10px); }
    }

    .fix-actions {
      margin-top: 16px;
      display: flex;
      gap: 10px;
    }

    .fix-button {
      padding: 10px 18px;
      background: linear-gradient(135deg, #1e90ff 0%, #0066cc 100%);
      color: white;
      border: none;
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      font-weight: 500;
      transition: transform 0.2s;
    }

    .fix-button:hover { transform: scale(1.05); }

    .fix-button.secondary {
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }

    .suggested-prompts {
      margin-top: 12px;
      display: flex;
      flex-direction: column;
      gap: 8px;
    }

    .prompt-button {
      padding: 10px 14px;
      background: rgba(30, 144, 255, 0.1);
      color: var(--vscode-foreground);
      border: 1px solid rgba(30, 144, 255, 0.3);
      border-radius: 8px;
      cursor: pointer;
      font-size: 13px;
      text-align: left;
      transition: all 0.2s;
    }

    .prompt-button:hover {
      background: rgba(30, 144, 255, 0.2);
      border-color: rgba(30, 144, 255, 0.5);
      transform: translateX(4px);
    }

    .input-container {
      padding: 16px;
      background-color: var(--vscode-editor-background);
      border-top: 1px solid var(--vscode-panel-border);
      display: flex;
      gap: 10px;
      align-items: flex-end;
    }

    #messageInput {
      flex: 1;
      padding: 12px 16px;
      background-color: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 12px;
      font-family: var(--vscode-font-family);
      font-size: 14px;
      resize: vertical;
      min-height: 60px;
      max-height: 300px;
    }

    #sendButton {
      padding: 12px 24px;
      background: linear-gradient(135deg, #1e90ff 0%, #0066cc 100%);
      color: white;
      border: none;
      border-radius: 24px;
      cursor: pointer;
      font-size: 14px;
      font-weight: 500;
    }

    #sendButton:hover { opacity: 0.9; }
  </style>
</head>
<body>
  <div class="header">
    <img src="${logoUri}" alt="Tivra Logo" class="logo" />
    <div>
      <h2>DebugMind</h2>
      <div class="status">AI Debugging Assistant</div>
    </div>
  </div>

  <div class="messages" id="messages"></div>

  <div class="input-container">
    <textarea
      id="messageInput"
      placeholder="Paste your error logs here or ask me a question..."
      autocomplete="off"
      rows="3"
    ></textarea>
    <button id="sendButton">Send</button>
  </div>

  <script>
    const vscode = acquireVsCodeApi();
    const messagesContainer = document.getElementById('messages');
    const messageInput = document.getElementById('messageInput');
    const sendButton = document.getElementById('sendButton');

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'update') {
        renderMessages(message.messages);
      }
    });

    function renderMessages(messages) {
      messagesContainer.innerHTML = '';

      messages.forEach(msg => {
        const messageDiv = document.createElement('div');
        messageDiv.className = \`message \${msg.type}\`;

        let html = '';

        if (msg.type !== 'system') {
          html += \`<div class="message-header">\`;
          html += msg.type === 'user' ? '👤 You' : '🤖 DebugMind';
          html += \` • \${new Date(msg.timestamp).toLocaleTimeString()}\`;
          html += \`</div>\`;
        }

        if (msg.isTyping) {
          html += \`<div class="typing-indicator"><span></span><span></span><span></span></div>\`;
        } else {
          html += \`<div class="message-content">\${formatContent(msg.content)}</div>\`;

          if (msg.suggestedPrompts && msg.suggestedPrompts.length > 0) {
            html += \`<div class="suggested-prompts">\`;
            msg.suggestedPrompts.forEach(prompt => {
              const escapedPrompt = prompt.replace(/'/g, "&apos;").replace(/"/g, "&quot;");
              html += \`<button class="prompt-button" onclick='sendPrompt("\${escapedPrompt}")'>\${prompt}</button>\`;
            });
            html += \`</div>\`;
          }
        }

        messageDiv.innerHTML = html;
        messagesContainer.appendChild(messageDiv);
      });

      messagesContainer.scrollTop = messagesContainer.scrollHeight;
    }

    function formatContent(content) {
      const backtick = String.fromCharCode(96);
      content = content.replace(/\\n/g, '<br>');
      content = content.replace(/\`\`\`([\\s\\S]*?)\`\`\`/g, '<pre><code>$1</code></pre>');
      const singleBacktickRegex = new RegExp(backtick + '([^' + backtick + ']+)' + backtick, 'g');
      content = content.replace(singleBacktickRegex, '<code>$1</code>');
      content = content.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
      content = content.replace(/^### (.+)$/gm, '<h3>$1</h3>');
      content = content.replace(/^## (.+)$/gm, '<h2>$1</h2>');
      return content;
    }

    function sendMessage() {
      const text = messageInput.value.trim();
      if (!text) return;

      vscode.postMessage({ type: 'userMessage', text: text });
      messageInput.value = '';
    }

    function applyFix(fix) {
      vscode.postMessage({ type: 'applyFix', fix: fix });
    }

    function rejectFix() {
      vscode.postMessage({ type: 'rejectFix' });
    }

    function sendPrompt(prompt) {
      messageInput.value = prompt;
      sendMessage();
    }

    sendButton.addEventListener('click', sendMessage);
    messageInput.addEventListener('keydown', (e) => {
      // Enter without Shift sends the message
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendMessage();
      }
      // Shift+Enter allows new line (default textarea behavior)
    });
  </script>
</body>
</html>`;
  }

  /**
   * Get GitHub repository from workspace
   * Attempts to extract GitHub repo from git remote URL
   */
  private async getGitHubRepoFromWorkspace(): Promise<string | undefined> {
    try {
      // First, check if user has manually configured the GitHub repo
      const configuredRepo = vscode.workspace.getConfiguration('tivra').get<string>('githubRepo');
      if (configuredRepo && configuredRepo.trim()) {
        console.log('[Tivra DebugMind] Using configured GitHub repo:', configuredRepo);
        return configuredRepo.trim();
      }

      // Otherwise, try to auto-detect from git remote
      const workspaceFolder = vscode.workspace.workspaceFolders?.[0];
      if (!workspaceFolder) {
        console.log('[Tivra DebugMind] No workspace folder, cannot auto-detect GitHub repo');
        return undefined;
      }

      // Try to get git remote URL
      const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
      if (!gitExtension) {
        console.log('[Tivra DebugMind] Git extension not found, cannot auto-detect GitHub repo');
        return undefined;
      }

      const api = gitExtension.getAPI(1);
      if (!api.repositories || api.repositories.length === 0) {
        console.log('[Tivra DebugMind] No git repositories found, cannot auto-detect GitHub repo');
        return undefined;
      }

      const repo = api.repositories[0];
      const remotes = repo.state.remotes;

      // Look for origin remote
      const origin = remotes.find((r: any) => r.name === 'origin');
      if (!origin) {
        console.log('[Tivra DebugMind] No origin remote found, cannot auto-detect GitHub repo');
        return undefined;
      }

      // Extract repo from URL (e.g., git@github.com:user/repo.git -> user/repo)
      const url = origin.fetchUrl || origin.pushUrl;
      if (!url) {
        console.log('[Tivra DebugMind] No remote URL found, cannot auto-detect GitHub repo');
        return undefined;
      }

      // Handle different URL formats
      let match;

      // SSH format: git@github.com:user/repo.git
      match = url.match(/git@github\.com:(.+?)\.git$/);
      if (match) {
        console.log('[Tivra DebugMind] Auto-detected GitHub repo from SSH URL:', match[1]);
        return match[1];
      }

      // HTTPS format: https://github.com/user/repo.git
      match = url.match(/https:\/\/github\.com\/(.+?)\.git$/);
      if (match) {
        console.log('[Tivra DebugMind] Auto-detected GitHub repo from HTTPS URL:', match[1]);
        return match[1];
      }

      // HTTPS without .git: https://github.com/user/repo
      match = url.match(/https:\/\/github\.com\/(.+?)$/);
      if (match) {
        console.log('[Tivra DebugMind] Auto-detected GitHub repo from HTTPS URL (no .git):', match[1]);
        return match[1];
      }

      console.log('[Tivra DebugMind] Could not parse GitHub repo from remote URL:', url);
      return undefined;
    } catch (error) {
      console.error('[Tivra DebugMind] Failed to get GitHub repo:', error);
      return undefined;
    }
  }

  /**
   * Get current git branch
   */
  private async getCurrentBranch(): Promise<string | undefined> {
    try {
      const gitExtension = vscode.extensions.getExtension('vscode.git')?.exports;
      if (!gitExtension) {
        return undefined;
      }

      const api = gitExtension.getAPI(1);
      if (!api.repositories || api.repositories.length === 0) {
        return undefined;
      }

      const repo = api.repositories[0];
      return repo.state.HEAD?.name;
    } catch (error) {
      console.error('[Tivra DebugMind] Failed to get current branch:', error);
      return undefined;
    }
  }

  /**
   * Check if GitHub is connected (returns boolean)
   */
  private async isGitHubConnected(): Promise<boolean> {
    try {
      const response = await axios.get(`${this._apiUrl}/api/github/status`);
      return response.data.connected === true;
    } catch (error) {
      console.error('[Tivra DebugMind] Failed to check GitHub status:', error);
      return false;
    }
  }

  /**
   * Check GitHub connection status and prompt if needed
   */
  private async checkGitHubConnection() {
    try {
      const response = await axios.get(`${this._apiUrl}/api/github/status`);

      if (response.data.connected) {
        console.log('[Tivra DebugMind] GitHub connected:', response.data.owner + '/' + response.data.repo);
        this.addMessage({
          type: 'ai',
          content: `**GitHub Connected** ✅\n\nRepository: ${response.data.owner}/${response.data.repo}\nBranch: ${response.data.baseBranch}\n\nYou're all set! The SRE Agent will use this repository for code context during investigations.`,
          timestamp: new Date()
        });
      } else {
        // Not connected, prompt user
        this.addMessage({
          type: 'ai',
          content: `**Connect to GitHub** 🔗\n\nFor better investigation accuracy, connect your GitHub repository. This allows the SRE Agent to:\n\n• Analyze recent code changes\n• Fetch source code for context\n• Generate accurate fixes\n• Create pull requests automatically\n\nYou can connect now or skip this step.`,
          timestamp: new Date(),
          suggestedPrompts: [
            'Connect GitHub',
            'Skip for now'
          ]
        });
      }
    } catch (error) {
      console.error('[Tivra DebugMind] Failed to check GitHub status:', error);
      // Don't show error to user, just log it
    }
  }

  /**
   * Check GitHub connection after investigation completes
   * Only prompts if not connected, otherwise silent
   */
  private async checkGitHubConnectionAfterInvestigation() {
    try {
      const investigation = this._lastInvestigationResult;

      // Check if file was located for fix
      const fileLocated = investigation?.file_located || false;
      const hasGitHub = !!this._githubData;

      console.log('[Tivra DebugMind] File located:', fileLocated, 'GitHub connected:', hasGitHub);

      // Complete workflow guidance
      if (hasGitHub && fileLocated) {
        // Perfect case: GitHub connected AND file located
        this.addMessage({
          type: 'ai',
          content: `\n**✅ Investigation Complete - Ready for Fix**\n\n` +
                  `**File Located:** \`${investigation.fix_file}\`\n` +
                  `**Confidence:** ${((investigation.root_cause_confidence || 0) * 100).toFixed(0)}%\n\n` +
                  `**Next Step:** Review the fix, then I'll create a PR for you.`,
          timestamp: new Date(),
          suggestedPrompts: [
            'Approve and create PR'
          ]
        });
      } else if (hasGitHub && !fileLocated) {
        // GitHub connected but file not found
        this.addMessage({
          type: 'ai',
          content: `\n**⚠️ Manual Fix Required**\n\n` +
                  `I couldn't locate the exact file in your repository for this fix.\n\n` +
                  `**Suggested Fix:**\n${investigation.suggested_fix || 'See investigation details above'}\n\n` +
                  `**Next Step:** After you've implemented and deployed the fix, let me know.`,
          timestamp: new Date(),
          suggestedPrompts: [
            'Fix has been deployed'
          ]
        });
      } else {
        // GitHub not connected
        this.addMessage({
          type: 'ai',
          content: `\n**💡 Manual Fix Required (No GitHub Connected)**\n\n` +
                  `GitHub is not connected, so you'll need to implement the fix manually.\n\n` +
                  `**Next Step:** After you've implemented and deployed the fix, let me know.`,
          timestamp: new Date(),
          suggestedPrompts: [
            'Fix has been deployed'
          ]
        });
      }
    } catch (error) {
      console.error('[Tivra DebugMind] Failed to check GitHub status:', error);
      // Don't show error to user, just log it
    }
  }

  /**
   * Explain errors in detail with analysis
   */
  private async explainErrors() {
    if (!this._conversationContext.recentErrors || this._conversationContext.recentErrors.length === 0) {
      this.addMessage({
        type: 'ai',
        content: '⚠️ **No Errors to Explain**\n\nPlease analyze your service first to find errors.',
        timestamp: new Date(),
        suggestedPrompts: ['Analyze my AWS services']
      });
      return;
    }

    const errors = this._conversationContext.recentErrors;
    const serviceName = this._conversationContext.service?.name || 'your service';

    this.addMessage({
      type: 'system',
      content: `🔍 Analyzing error patterns and types...`,
      timestamp: new Date()
    });

    // Build detailed error analysis
    let analysis = `## 📊 Detailed Error Analysis for ${serviceName}\n\n`;

    analysis += `### Error Overview\n`;
    analysis += `Found **${errors.length} unique error types** with multiple occurrences.\n\n`;

    // Group errors by type/pattern
    const errorsByType: { [key: string]: any[] } = {};
    errors.forEach(err => {
      const errorType = err.type || 'Unknown';
      if (!errorsByType[errorType]) {
        errorsByType[errorType] = [];
      }
      errorsByType[errorType].push(err);
    });

    analysis += `### Error Types Breakdown\n\n`;
    Object.entries(errorsByType).forEach(([type, errs], index) => {
      const totalCount = errs.reduce((sum, e) => sum + (e.count || 1), 0);
      analysis += `**${index + 1}. ${type}** (${totalCount} occurrences)\n\n`;

      errs.forEach((err, i) => {
        analysis += `   **Error ${i + 1}:** ${err.message}\n`;
        analysis += `   • Occurrences: ${err.count || 1}\n`;
        if (err.lastSeen) {
          analysis += `   • Last seen: ${new Date(err.lastSeen).toLocaleString()}\n`;
        }
        if (err.samples && err.samples.length > 0) {
          const sample = err.samples[0].substring(0, 300);
          analysis += `   • Sample:\n   \`\`\`\n   ${sample}${err.samples[0].length > 300 ? '...' : ''}\n   \`\`\`\n`;
        }
        analysis += '\n';
      });
    });

    analysis += `### Recommended Next Steps\n\n`;
    analysis += `Based on the error patterns, I recommend:\n\n`;
    analysis += `1. **Start Investigation** - Run a full investigation to identify root causes\n`;
    analysis += `2. **Review Recent Changes** - Check if any recent deployments correlate with error spikes\n`;
    analysis += `3. **Monitor Trends** - Set up autonomous monitoring to catch future issues\n\n`;
    analysis += `Would you like me to investigate these errors?`;

    this.addMessage({
      type: 'ai',
      content: analysis,
      timestamp: new Date(),
      suggestedPrompts: [
        'Start investigation',
        'Skip for now',
        'Monitor new errors'
      ]
    });

    // Track error explanation
    this._analytics?.trackFeatureUsage('investigation', 'errors_explained', {
      errorCount: errors.length,
      errorTypes: Object.keys(errorsByType).length
    });
  }

  /**
   * Explain the last investigation's suggested fix
   */
  private async explainLastFix() {
    if (!this._lastInvestigationResult || !this._lastInvestigationResult.suggested_fixes ||
        this._lastInvestigationResult.suggested_fixes.length === 0) {
      this.addMessage({
        type: 'ai',
        content: '⚠️ **No Fix Available**\n\nThere are no fixes to explain. Please run an investigation first to get suggested fixes.',
        timestamp: new Date(),
        suggestedPrompts: ['Investigate my service', 'Analyze errors']
      });
      return;
    }

    const fix = this._lastInvestigationResult.suggested_fixes[0];
    const rootCause = this._lastInvestigationResult.root_cause;

    // Generate detailed explanation
    let explanation = `## 🔍 Fix Explanation\n\n`;

    // Problem section
    if (rootCause) {
      explanation += `### 🔴 The Problem\n`;
      explanation += `**Root Cause:** ${rootCause.category.replace('_', ' ')}\n`;
      explanation += `**Description:** ${rootCause.description}\n`;
      explanation += `**Impact:** ${rootCause.impact}\n\n`;
    }

    // Solution section
    explanation += `### ✅ The Solution\n`;
    explanation += `**Fix Type:** ${fix.type.replace('_', ' ').toUpperCase()}\n`;
    explanation += `**Description:** ${fix.description}\n`;
    explanation += `**Risk Level:** ${fix.risk_level}\n`;
    explanation += `**Estimated Time:** ${fix.estimated_time || '15-30 minutes'}\n\n`;

    // Why it works
    explanation += `### 💡 Why This Works\n`;
    if (fix.explanation) {
      explanation += `${fix.explanation}\n\n`;
    } else {
      explanation += `This fix addresses the root cause by ${fix.description.toLowerCase()}. `;
      explanation += `It has a ${(fix.confidence * 100).toFixed(0)}% confidence score based on the evidence gathered.\n\n`;
    }

    // Implementation
    if (fix.code || fix.implementation_steps) {
      explanation += `### 🔧 Implementation\n`;
      if (fix.code) {
        explanation += `\`\`\`${fix.language || 'javascript'}\n${fix.code}\n\`\`\`\n\n`;
      }
      if (fix.implementation_steps) {
        explanation += `**Steps:**\n`;
        fix.implementation_steps.forEach((step: string, idx: number) => {
          explanation += `${idx + 1}. ${step}\n`;
        });
        explanation += '\n';
      }
    }

    // Impact section
    explanation += `### 📊 Expected Impact\n`;
    if (fix.impact) {
      explanation += `${fix.impact}\n\n`;
    } else {
      explanation += `This fix should resolve the error and prevent future occurrences. Monitor logs after applying to verify.\n\n`;
    }

    // Alternatives
    if (this._lastInvestigationResult.suggested_fixes.length > 1) {
      explanation += `**Note:** There ${this._lastInvestigationResult.suggested_fixes.length - 1 === 1 ? 'is' : 'are'} ${this._lastInvestigationResult.suggested_fixes.length - 1} alternative fix${this._lastInvestigationResult.suggested_fixes.length - 1 === 1 ? '' : 'es'} available. Ask me to "show another fix option" to see them.\n\n`;
    }

    // Determine next steps based on context
    const investigation = this._lastInvestigationResult;
    const fileLocated = investigation?.file_located || false;
    let prompts: string[];

    if (this._githubData && fileLocated) {
      // Can create PR automatically
      prompts = ['Approve and create PR'];
    } else {
      // Manual fix required
      prompts = ['Fix has been deployed'];
    }

    this.addMessage({
      type: 'ai',
      content: explanation,
      timestamp: new Date(),
      suggestedPrompts: prompts
    });
  }

  /**
   * Approve fix and create PR
   */
  private async approveAndCreatePR() {
    if (!this._lastInvestigationResult) {
      this.addMessage({
        type: 'ai',
        content: '⚠️ **No Investigation Found**\n\nPlease run an investigation first before creating a PR.',
        timestamp: new Date(),
        suggestedPrompts: ['Investigate my service']
      });
      return;
    }

    const investigation = this._lastInvestigationResult;
    const sessionId = investigation.session_id || investigation.investigation_id;

    // Check if GitHub is connected
    if (!this._githubData) {
      this.addMessage({
        type: 'ai',
        content: '⚠️ **GitHub Not Connected**\n\nPlease connect GitHub first to create PRs.',
        timestamp: new Date(),
        suggestedPrompts: ['Connect GitHub']
      });
      return;
    }

    // Check if file was located
    if (!investigation.file_located || !investigation.fix_file) {
      this.addMessage({
        type: 'ai',
        content: '⚠️ **Cannot Create PR**\n\nThe exact file for this fix was not located in your repository. Manual implementation is required.',
        timestamp: new Date(),
        suggestedPrompts: ['Show me the suggested fix', 'Investigate another service']
      });
      return;
    }

    try {
      this.addMessage({
        type: 'system',
        content: '🔄 Creating PR...\n\n**Steps:**\n1️⃣ Approving fix\n2️⃣ Applying fix to code\n3️⃣ Creating branch\n4️⃣ Opening pull request',
        timestamp: new Date()
      });

      // Step 1: Approve fix
      await axios.post(`${this._apiUrl}/api/sre-agent/v2/approve-fix`, {
        session_id: sessionId,
        approved: true,
        user_feedback: 'Approved from VSCode'
      });

      // Step 2: Apply fix and create PR
      const applyResponse = await axios.post(`${this._apiUrl}/api/sre-agent/v2/apply-fix`, {
        session_id: sessionId,
        dry_run: false
      });

      const result = applyResponse.data;

      if (result.pr_link) {
        // Open PR in browser automatically
        vscode.env.openExternal(vscode.Uri.parse(result.pr_link));

        this.addMessage({
          type: 'ai',
          content: `✅ **PR Created Successfully!**\n\n` +
                  `**PR URL:** ${result.pr_link}\n\n` +
                  `I've opened the PR in your browser.\n\n` +
                  `**Manual Steps Required:**\n\n` +
                  `1️⃣ **Review the PR** - Check the code changes on GitHub\n` +
                  `2️⃣ **Merge the PR** - Approve and merge when ready\n` +
                  `3️⃣ **Deploy the fix** - Deploy to your environment (production/staging)\n` +
                  `4️⃣ **Tell me when deployed** - Let me know when deployment is complete\n\n` +
                  `**Next Step:** After you've reviewed, merged, and deployed, let me know.`,
          timestamp: new Date(),
          suggestedPrompts: [
            'Fix has been deployed',
            'Monitor new errors'
          ]
        });
      } else if (result.status === 'manual_action_required') {
        // Manual config change or file not located - fetch full investigation to show details
        const message = result.verification?.message || result.message || 'Manual intervention required';

        // Fetch the investigation to get the full suggested fix details
        try {
          const invResponse = await axios.get(`${this._apiUrl}/api/sre-agent/v2/investigation/${sessionId}`);
          const investigation = invResponse.data;

          this.addMessage({
            type: 'ai',
            content: `⚙️ **Manual Configuration Change Required**\n\n` +
                    `**Root Cause:**\n${investigation.root_cause || 'See analysis above'}\n\n` +
                    `**Suggested Fix:**\n${investigation.suggested_fix || message}\n\n` +
                    `**What to do:**\n` +
                    `1️⃣ Apply the configuration change described above\n` +
                    `2️⃣ Deploy the change to your environment\n` +
                    `3️⃣ Let me know when deployed for validation`,
            timestamp: new Date(),
            suggestedPrompts: [
              'Fix has been deployed',
              'Monitor new errors'
            ]
          });
        } catch (fetchError) {
          // Fallback if we can't fetch investigation
          this.addMessage({
            type: 'ai',
            content: `⚙️ **Manual Action Required**\n\n` +
                    `${message}\n\n` +
                    `**What to do:**\n` +
                    `1️⃣ Review the suggested fix from the investigation\n` +
                    `2️⃣ Apply the configuration change manually\n` +
                    `3️⃣ Deploy the change to your environment\n` +
                    `4️⃣ Let me know when deployed for validation`,
            timestamp: new Date(),
            suggestedPrompts: [
              'Fix has been deployed',
              'Monitor new errors'
            ]
          });
        }
      } else {
        // Check if this is an old investigation format issue
        if (result.status === 'error' && result.message?.includes('missing fix details')) {
          this.addMessage({
            type: 'ai',
            content: `⚠️ **Investigation Format Out of Date**\n\n` +
                    `This investigation was created with an older version and is missing required fields for PR creation.\n\n` +
                    `**Solution:** Run a new investigation to get the latest format with all features.\n\n` +
                    `${result.message}`,
            timestamp: new Date(),
            suggestedPrompts: [
              'Start investigation',
              'Monitor new errors'
            ]
          });
        } else if (result.status === 'error' && result.message?.includes('Investigation format changes')) {
          this.addMessage({
            type: 'ai',
            content: `⚠️ **Investigation Format Out of Date**\n\n` +
                    `This investigation format has changed. Please run a new investigation.\n\n` +
                    `${result.message}`,
            timestamp: new Date(),
            suggestedPrompts: [
              'Start investigation',
              'Monitor new errors'
            ]
          });
        } else {
          // Generic error message
          this.addMessage({
            type: 'ai',
            content: `⚠️ **PR Creation Status: ${result.status}**\n\n${result.message || result.verification?.message || 'PR creation completed with warnings.'}`,
            timestamp: new Date(),
            suggestedPrompts: ['Monitor new errors']
          });
        }
      }

    } catch (error: any) {
      console.error('[Tivra DebugMind] Failed to create PR:', error);
      this.addMessage({
        type: 'ai',
        content: `❌ **PR Creation Failed**\n\n${error.response?.data?.message || error.message}`,
        timestamp: new Date(),
        suggestedPrompts: ['Try again', 'Monitor new errors']
      });
    }
  }

  /**
   * Validate deployment after PR merge
   */
  private async validateDeployment() {
    if (!this._lastInvestigationResult) {
      this.addMessage({
        type: 'ai',
        content: '⚠️ **No Investigation Found**\n\nPlease run an investigation first.',
        timestamp: new Date(),
        suggestedPrompts: ['Investigate my service']
      });
      return;
    }

    const investigation = this._lastInvestigationResult;
    const sessionId = investigation.session_id || investigation.investigation_id;

    try {
      this.addMessage({
        type: 'system',
        content: '🔍 Validating deployment...\n\nChecking if errors are resolved (last 15 minutes)...',
        timestamp: new Date()
      });

      const validateResponse = await axios.post(`${this._apiUrl}/api/sre-agent/v2/validate-deployment`, {
        session_id: sessionId,
        lookback_minutes: 15
      });

      const result = validateResponse.data;

      if (result.errors_resolved) {
        // Errors resolved - store learnings
        await axios.post(`${this._apiUrl}/api/sre-agent/v2/store-learnings`, {
          session_id: sessionId,
          resolved: true
        });

        this.addMessage({
          type: 'ai',
          content: `✅ **Deployment Validated Successfully!**\n\n` +
                  `${result.message}\n\n` +
                  `**Error Reduction:**\n` +
                  `• Before: ${result.error_count_before} errors\n` +
                  `• After: ${result.error_count_after} errors\n` +
                  `• Reduction: ${result.reduction_percentage.toFixed(0)}%\n\n` +
                  `**Investigation Complete!**\n` +
                  `This investigation has been stored for future reference.`,
          timestamp: new Date()
        });

        // Request user feedback
        this.addMessage({
          type: 'ai',
          content: `## 📊 Quick Feedback\n\n` +
                  `How would you rate this investigation?`,
          timestamp: new Date(),
          suggestedPrompts: [
            '⭐⭐⭐⭐⭐ Excellent (5/5)',
            '⭐⭐⭐⭐ Good (4/5)',
            '⭐⭐⭐ Okay (3/5)',
            '⭐⭐ Poor (2/5)',
            '⭐ Very Poor (1/5)',
            'Skip feedback'
          ]
        });

        // Store session ID for feedback submission
        this._pendingFeedbackSessionId = sessionId;
      } else {
        this.addMessage({
          type: 'ai',
          content: `⚠️ **Errors Still Present**\n\n` +
                  `${result.message}\n\n` +
                  `**Error Counts:**\n` +
                  `• Before: ${result.error_count_before} errors\n` +
                  `• After: ${result.error_count_after} errors\n` +
                  `• Reduction: ${result.reduction_percentage?.toFixed(0) || 0}%\n\n` +
                  `**Recommendation:** ${result.recommendation}\n\n` +
                  `**Recent Errors:**\n${result.recent_errors?.slice(0, 3).map((e: string) => `• ${e}`).join('\n') || 'No samples available'}`,
          timestamp: new Date(),
          suggestedPrompts: [
            'Investigate again',
            'Monitor new errors'
          ]
        });
      }

    } catch (error: any) {
      console.error('[Tivra DebugMind] Failed to validate deployment:', error);
      this.addMessage({
        type: 'ai',
        content: `❌ **Validation Failed**\n\n${error.response?.data?.message || error.message}\n\nPlease ensure the deployment is complete and try again.`,
        timestamp: new Date(),
        suggestedPrompts: ['Try validation again', 'Monitor new errors']
      });
    }
  }

  /**
   * Handle user feedback rating
   */
  private async handleFeedbackRating(ratingText: string) {
    // Parse rating from text
    let rating = 0;
    if (ratingText.includes('5/5') || ratingText.toLowerCase().includes('excellent')) {
      rating = 5;
    } else if (ratingText.includes('4/5') || ratingText.toLowerCase().includes('good')) {
      rating = 4;
    } else if (ratingText.includes('3/5') || ratingText.toLowerCase().includes('okay')) {
      rating = 3;
    } else if (ratingText.includes('2/5') || ratingText.toLowerCase().includes('poor (2')) {
      rating = 2;
    } else if (ratingText.includes('1/5') || ratingText.toLowerCase().includes('very poor')) {
      rating = 1;
    }

    if (rating === 0) {
      this.addMessage({
        type: 'ai',
        content: `I didn't understand that rating. Please select one of the options above.`,
        timestamp: new Date()
      });
      return;
    }

    const sessionId = this._pendingFeedbackSessionId;
    this._pendingFeedbackSessionId = null;

    if (!sessionId) {
      return;
    }

    try {
      // Submit feedback to backend
      const response = await axios.post(`${this._apiUrl}/api/sre-agent/v2/submit-feedback`, {
        session_id: sessionId,
        satisfaction_rating: rating
      });

      this.addMessage({
        type: 'ai',
        content: `✅ ${response.data.message || 'Thank you for your feedback!'}\n\n` +
                `Your feedback helps us improve the debugging experience.`,
        timestamp: new Date(),
        suggestedPrompts: [
          'Monitor new errors',
          'Analyze another service'
        ]
      });

      console.log(`[Tivra DebugMind] Feedback submitted: ${rating}/5 for session ${sessionId}`);

    } catch (error: any) {
      console.error('[Tivra DebugMind] Failed to submit feedback:', error);

      // Still thank the user even if submission fails
      this.addMessage({
        type: 'ai',
        content: `Thank you for your feedback (${rating}/5)!\n\n` +
                `Note: Feedback could not be saved due to a connection issue, but we appreciate your input.`,
        timestamp: new Date(),
        suggestedPrompts: [
          'Monitor new errors',
          'Analyze another service'
        ]
      });
    }
  }

  /**
   * Start GitHub OAuth flow
   */
  private async startGitHubOAuth() {
    this.addMessage({
      type: 'system',
      content: `🔄 Opening GitHub OAuth in your browser...`,
      timestamp: new Date()
    });

    try {
      // Generate unique state token for polling
      const state = `vscode-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Open OAuth URL in browser with state
      const authUrl = `${this._apiUrl}/api/github/auth?vscode_state=${state}`;
      await vscode.env.openExternal(vscode.Uri.parse(authUrl));

      this.addMessage({
        type: 'system',
        content: `🔄 Polling for GitHub authorization...`,
        timestamp: new Date()
      });

      // Poll for connection status with state token
      this.pollForGitHubConnection(state);
    } catch (error: any) {
      console.error('[Tivra DebugMind] GitHub OAuth failed:', error);
      this.addMessage({
        type: 'ai',
        content: `⚠️ **GitHub OAuth Error**\n\nFailed to start OAuth flow: ${error.message}\n\nYou can try again later or skip this step.`,
        timestamp: new Date(),
        suggestedPrompts: [
          'Retry GitHub',
          'Skip for now'
        ]
      });
    }
  }

  /**
   * Poll for GitHub connection status using state token
   */
  private async pollForGitHubConnection(state: string) {
    let attempts = 0;
    const maxAttempts = 60; // 60 seconds

    console.log(`[Tivra DebugMind] Polling for GitHub OAuth completion with state: ${state}`);

    const poll = setInterval(async () => {
      attempts++;

      try {
        // Poll the specific endpoint with state token
        const response = await axios.get(`${this._apiUrl}/api/github/auth/poll/${state}`);

        if (response.data.connected) {
          clearInterval(poll);

          console.log('[Tivra DebugMind] GitHub OAuth completed successfully');

          // Store GitHub data for use in investigations
          this._githubData = {
            token: response.data.githubToken,
            owner: response.data.owner,
            repo: response.data.repo,
            baseBranch: response.data.baseBranch,
            user: response.data.user
          };

          // Persist to VSCode globalState so it survives reloads
          await this._context.globalState.update('tivra_github_data', this._githubData);

          console.log(`[Tivra DebugMind] Stored GitHub data: ${this._githubData.owner}/${this._githubData.repo}`);

          this.addMessage({
            type: 'ai',
            content: `✅ **GitHub Connected Successfully!**\n\nRepository: ${response.data.owner}/${response.data.repo}\nBranch: ${response.data.baseBranch}\n\nThe SRE Agent will now use this repository for code analysis during investigations.`,
            timestamp: new Date()
          });

          // If we're in the investigation flow, proceed with investigation
          if (this._conversationContext.recentErrors.length > 0) {
            this.addMessage({
              type: 'system',
              content: `🤖 Starting deep investigation with GitHub context...`,
              timestamp: new Date()
            });
            await this.triggerSREInvestigation();
          }
        }
      } catch (error) {
        console.error('[Tivra DebugMind] Poll error:', error);
      }

      if (attempts >= maxAttempts) {
        clearInterval(poll);
        this.addMessage({
          type: 'ai',
          content: `⚠️ **GitHub Authorization Not Detected**\n\nDidn't receive authorization after 60 seconds. This could mean:\n• OAuth flow was cancelled\n• Authorization wasn't completed\n• Network connectivity issue\n\nWould you like to try again or proceed without GitHub?`,
          timestamp: new Date(),
          suggestedPrompts: [
            'Connect GitHub',
            'Skip - Investigate without GitHub'
          ]
        });
      }
    }, 1000); // Check every second
  }

  // ========================================
  // Autonomous Monitoring Methods (Agent-Side)
  // ========================================

  /**
   * Start autonomous monitoring (agent-side, no polling)
   * Called once when AWS connection is established
   */
  private async startAutonomousMonitoring(services: any[]) {
    if (!services || services.length === 0) {
      console.log('[Tivra DebugMind] No services to monitor');
      this.addMessage({
        type: 'ai',
        content: `⚠️ **No Services Available**\n\nPlease analyze your AWS services first, then I can start monitoring.`,
        timestamp: new Date(),
        suggestedPrompts: ['Analyze my AWS services']
      });
      return;
    }

    console.log(`[Tivra DebugMind] Starting autonomous monitoring for ${services.length} service(s)`);

    this.addMessage({
      type: 'system',
      content: `🔄 Starting autonomous monitoring for new errors...`,
      timestamp: new Date()
    });

    // Filter services that have log groups configured (check both logGroupName and logGroup)
    const servicesWithLogs = services.filter((s: any) => s.logGroupName || s.logGroup);

    if (servicesWithLogs.length === 0) {
      console.log('[Tivra DebugMind] No services with log groups configured');
      this.addMessage({
        type: 'ai',
        content: `⚠️ **No Log Groups Configured**\n\n` +
                `None of your ${services.length} service(s) have log groups configured. ` +
                `To start autonomous monitoring, I need services with CloudWatch log groups.\n\n` +
                `**What to do:**\n` +
                `• Analyze services with log groups (Lambda, ECS, etc.)\n` +
                `• For EC2 instances, provide the CloudWatch log group name when prompted\n\n` +
                `Would you like to analyze your services again?`,
        timestamp: new Date(),
        suggestedPrompts: ['Analyze my AWS services', 'Show me how to configure log groups']
      });
      return;
    }

    this.addMessage({
      type: 'system',
      content: `🤖 **Autonomous Monitoring Started**\n\n` +
              `Checking ${servicesWithLogs.length} service(s) for errors...`,
      timestamp: new Date()
    });

    try {
      // Fetch errors for each service (without auto-investigation)
      let servicesChecked = 0;
      let servicesWithErrors = 0;
      let allErrors: any[] = [];

      for (const service of servicesWithLogs) {
        this.addMessage({
          type: 'system',
          content: `🔍 Checking ${service.name} for errors...`,
          timestamp: new Date()
        });

        try {
          const response = await axios.post(`${this._apiUrl}/api/sre-agent/fetch-errors`, {
            service: {
              name: service.name,
              logGroupName: service.logGroupName || service.logGroup,
              region: service.region || 'us-east-1',
              type: service.type
            },
            lookback_minutes: 60
          });

          servicesChecked++;

          // Check if errors were found
          if (response.data.status === 'errors_found') {
            servicesWithErrors++;
            const errorData = response.data;

            // Store errors in context for later investigation
            allErrors.push({
              service: service.name,
              errors: errorData.errors,
              errorSummary: errorData.error_summary,
              totalErrors: errorData.total_errors
            });

            // Show brief error summary for this service
            let errorMessage = `## ⚠️ Errors Found: ${service.name}\n\n`;
            errorMessage += `**Total Errors:** ${errorData.total_errors}\n`;
            errorMessage += `**Error Types:** ${Object.keys(errorData.error_summary).length}\n\n`;

            // Show top 3 error types
            const topErrors = Object.entries(errorData.error_summary)
              .sort((a: any, b: any) => b[1].count - a[1].count)
              .slice(0, 3);

            errorMessage += `**Top Error Types:**\n`;
            topErrors.forEach(([type, info]: [string, any], idx) => {
              errorMessage += `${idx + 1}. **${type}** (${info.count} occurrences)\n`;
            });

            this.addMessage({
              type: 'system',
              content: errorMessage,
              timestamp: new Date()
            });

          } else if (response.data.status === 'no_errors') {
            this.addMessage({
              type: 'system',
              content: `✅ ${service.name}: No errors found`,
              timestamp: new Date()
            });
          }

          console.log(`[Tivra DebugMind] Completed error check for ${service.name}`);

        } catch (serviceError: any) {
          console.error(`[Tivra DebugMind] Error check failed for ${service.name}:`, serviceError);
          this.addMessage({
            type: 'system',
            content: `⚠️ ${service.name}: Error check failed - ${serviceError.message}`,
            timestamp: new Date()
          });
        }
      }

      // Store errors in conversation context for later use
      if (allErrors.length > 0) {
        this._conversationContext.recentErrors = allErrors.flatMap(s =>
          s.errors.map((e: any) => ({ ...e, service: s.service }))
        );
      }

      // Summary with two-path prompts
      if (servicesWithErrors > 0) {
        this.addMessage({
          type: 'ai',
          content: `## 🤖 Autonomous Monitoring Complete\n\n` +
                  `✅ Checked ${servicesChecked} service(s)\n` +
                  `⚠️ Found errors in ${servicesWithErrors} service(s)\n\n` +
                  `**What would you like to do next?**\n` +
                  `• **Explain errors in detail** - Get detailed analysis of error patterns\n` +
                  `• **Start investigation** - Run full investigation and get fix suggestions\n` +
                  `• **Skip for now** - Continue monitoring without investigation`,
          timestamp: new Date(),
          suggestedPrompts: [
            'Explain errors in detail',
            'Start investigation',
            'Skip for now'
          ]
        });
      } else {
        this.addMessage({
          type: 'ai',
          content: `## 🤖 Autonomous Monitoring Complete\n\n` +
                  `✅ Checked ${servicesChecked} service(s)\n` +
                  `✅ All services are healthy! No errors detected.\n\n` +
                  `I'll continue monitoring your services.`,
          timestamp: new Date(),
          suggestedPrompts: ['Monitor new errors', 'Analyze another service']
        });
      }

      this._autonomousMonitoringActive = true;
      this._isMonitoring = false; // One-time check completed

    } catch (error: any) {
      console.error('[Tivra DebugMind] Failed to start autonomous monitoring:', error);

      this.addMessage({
        type: 'system',
        content: `❌ Failed to start autonomous monitoring: ${error.message}\n\n` +
                `You can still manually trigger investigations.`,
        timestamp: new Date()
      });
    }
  }

  public async dispose() {
    await this.stopAutonomousMonitoring();

    // Destroy encryption session
    if (this._encryption) {
      await this._encryption.destroySession();
      this._encryption = null;
    }

    DebugCopilot.currentPanel = undefined;
    this._panel.dispose();
    while (this._disposables.length) {
      const disposable = this._disposables.pop();
      if (disposable) disposable.dispose();
    }
  }
}

interface ChatMessage {
  type: 'user' | 'ai' | 'system';
  content: string;
  timestamp: Date;
  suggestedFix?: CodeFix;
  suggestedPrompts?: string[];
  isTyping?: boolean;
}

interface CodeFix {
  filePath: string;
  newCode: string;
  explanation: string;
}

interface ConversationContext {
  service: { name: string; type: string; logGroupName?: string; region?: string } | null;
  recentErrors: any[];
  appliedFixes: Array<{ filePath: string; code: string; description: string; timestamp?: Date }>;
  conversationHistory: Array<{ role: 'user' | 'assistant'; content: string }>;
}
