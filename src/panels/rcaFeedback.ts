// RCA Feedback Handler
// Decoupled from DebugCopilot so this file can grow independently.
// Handles: post-fix feedback collection, correction submission, and
// static helpers that inject feedback UI into the webview HTML.

import axios from 'axios';
import { AnalyticsTracker } from '../analytics/analytics-tracker';

export class RCAFeedbackHandler {
  private _apiUrl: string;
  private _analytics: AnalyticsTracker | undefined;
  private _addMessage: (msg: { type: 'user' | 'ai' | 'system'; content: string; timestamp: Date }) => void;

  constructor(
    apiUrl: string,
    addMessage: (msg: { type: 'user' | 'ai' | 'system'; content: string; timestamp: Date }) => void,
    analytics?: AnalyticsTracker
  ) {
    this._apiUrl = apiUrl;
    this._addMessage = addMessage;
    this._analytics = analytics;
  }

  async submitFeedback(sessionId: string, helpful: boolean, correction?: string): Promise<void> {
    try {
      await axios.post(`${this._apiUrl}/api/try-mode/feedback`, {
        session_id: sessionId,
        helpful,
        correct_rca: helpful,
        actual_cause: correction || null,
        corrected_fix: correction || null,
        rating: helpful ? 5 : 2
      });

      this._addMessage({
        type: 'system',
        content: helpful
          ? '✅ Thanks! Feedback recorded — this helps improve future analysis.'
          : '📝 Correction noted! We\'ll use this to improve our model.',
        timestamp: new Date()
      });

      this._analytics?.trackFeatureUsage('rca', helpful ? 'feedback_positive' : 'feedback_negative');
    } catch (error: any) {
      console.error('[Tivra] Failed to submit RCA feedback:', error.message);
    }
  }

  /** CSS to embed inside the webview <style> block. */
  static webviewStyles(): string {
    return `
    .feedback-card {
      margin-top: 12px;
      padding: 12px 14px;
      background: rgba(30, 144, 255, 0.07);
      border: 1px solid rgba(30, 144, 255, 0.22);
      border-radius: 8px;
    }
    .feedback-question { margin: 0 0 10px; font-size: 13px; opacity: 0.88; }
    .feedback-done    { margin: 0; font-size: 13px; opacity: 0.88; }
    .feedback-buttons { display: flex; gap: 8px; flex-wrap: wrap; }
    .feedback-btn {
      padding: 5px 13px;
      border-radius: 6px;
      border: 1px solid rgba(255,255,255,0.18);
      cursor: pointer;
      font-size: 13px;
      background: transparent;
      color: var(--vscode-foreground);
      transition: opacity 0.15s;
    }
    .feedback-btn.yes { border-color: rgba(0,200,100,0.45); color: #00c864; }
    .feedback-btn.no  { border-color: rgba(255,80,80,0.45);  color: #ff5050; }
    .feedback-btn:disabled { opacity: 0.4; cursor: default; }
    .feedback-btn:not(:disabled):hover { opacity: 0.75; }
    .correction-area { margin-top: 10px; }
    .correction-area textarea {
      width: 100%;
      min-height: 64px;
      padding: 8px;
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      border: 1px solid var(--vscode-input-border);
      border-radius: 6px;
      font-family: var(--vscode-font-family);
      font-size: 13px;
      box-sizing: border-box;
      resize: vertical;
    }
    .correction-submit {
      margin-top: 6px;
      padding: 5px 13px;
      background: rgba(30,144,255,0.25);
      border: 1px solid rgba(30,144,255,0.45);
      border-radius: 6px;
      color: var(--vscode-foreground);
      cursor: pointer;
      font-size: 13px;
    }
    .correction-submit:hover { opacity: 0.8; }
    `;
  }

  /**
   * JS functions to embed inside the webview <script> block.
   * Uses data-* attributes so session IDs never need quote-escaping.
   */
  static webviewScript(): string {
    return `
    function onFeedback(btn) {
      var sid = btn.dataset.session;
      var helpful = btn.dataset.helpful === 'true';
      if (helpful) {
        vscode.postMessage({ type: 'rcaFeedback', sessionId: sid, helpful: true });
        btn.closest('.feedback-card').innerHTML = '<p class="feedback-done">✅ Thanks! Feedback recorded.</p>';
      } else {
        var area = document.getElementById('correction-' + sid);
        if (area) { area.style.display = 'block'; }
        btn.closest('.feedback-buttons').querySelectorAll('.feedback-btn').forEach(function(b) { b.disabled = true; });
      }
    }

    function submitCorrection(btn) {
      var sid = btn.dataset.session;
      var textarea = document.getElementById('correction-text-' + sid);
      var correction = textarea ? textarea.value.trim() : '';
      vscode.postMessage({ type: 'rcaFeedback', sessionId: sid, helpful: false, correction: correction });
      btn.closest('.feedback-card').innerHTML = '<p class="feedback-done">📝 Correction noted! This helps improve our model.</p>';
    }
    `;
  }

  /**
   * Build feedback card HTML for a given session.
   * Called from renderMessages() inside the webview when msg.feedbackCard is set.
   * Returns a plain HTML string safe to concatenate into innerHTML.
   */
  static buildCardHtml(sessionId: string): string {
    return (
      '<div class="feedback-card">' +
        '<p class="feedback-question">Did this fix resolve your issue? Your feedback trains our AI.</p>' +
        '<div class="feedback-buttons">' +
          '<button class="feedback-btn yes" data-session="' + sessionId + '" data-helpful="true" onclick="onFeedback(this)">✅ Yes, it worked!</button>' +
          '<button class="feedback-btn no"  data-session="' + sessionId + '" data-helpful="false" onclick="onFeedback(this)">❌ No, it didn\'t work</button>' +
        '</div>' +
        '<div class="correction-area" id="correction-' + sessionId + '" style="display:none">' +
          '<textarea id="correction-text-' + sessionId + '" placeholder="What was the actual root cause or correct fix? (optional — helps fine-tune our model)"></textarea>' +
          '<button class="correction-submit" data-session="' + sessionId + '" onclick="submitCorrection(this)">Submit Correction</button>' +
        '</div>' +
      '</div>'
    );
  }
}
