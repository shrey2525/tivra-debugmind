/**
 * Log Parser for Local Mode
 * Parses pasted logs and extracts errors, warnings, and structured data
 */

export interface StackTraceEntry {
  file: string;
  line?: number;
  method?: string;
  className?: string;
  rawLine: string;
}

export interface ParsedError {
  timestamp?: string;
  level: 'ERROR' | 'FATAL' | 'CRITICAL' | 'SEVERE';
  message: string;
  stackTrace?: string[];
  stackTraceEntries?: StackTraceEntry[];
  count: number;
  samples: string[];
  rawLines: string[];
}

export interface ParsedLogs {
  totalLines: number;
  errors: ParsedError[];
  warnings: number;
  info: number;
  debug: number;
  timeRange?: {
    start: string;
    end: string;
  };
  detectedFormat?: string;
}

export class LocalLogParser {
  /**
   * Parse raw log text into structured format
   */
  public parse(rawLogs: string): ParsedLogs {
    if (!rawLogs || rawLogs.trim().length === 0) {
      throw new Error('No logs provided');
    }

    const lines = rawLogs.split('\n').filter(line => line.trim().length > 0);

    if (lines.length < 5) {
      throw new Error('Too few log lines (minimum 5 required)');
    }

    const detectedFormat = this.detectLogFormat(lines);

    // Parse each line
    const parsedLines = lines.map(line => this.parseLine(line));

    // Count by level
    const errorLines = parsedLines.filter(l => l.level === 'ERROR' || l.level === 'FATAL' || l.level === 'CRITICAL' || l.level === 'SEVERE');
    const warnLines = parsedLines.filter(l => l.level === 'WARN' || l.level === 'WARNING');
    const infoLines = parsedLines.filter(l => l.level === 'INFO');
    const debugLines = parsedLines.filter(l => l.level === 'DEBUG' || l.level === 'TRACE');

    // Group errors by message
    const groupedErrors = this.groupErrors(errorLines, lines);

    // Extract time range
    const timestamps = parsedLines
      .map(l => l.timestamp)
      .filter(t => t !== undefined) as string[];

    const timeRange = timestamps.length > 0 ? {
      start: timestamps[0],
      end: timestamps[timestamps.length - 1]
    } : undefined;

    return {
      totalLines: lines.length,
      errors: groupedErrors,
      warnings: warnLines.length,
      info: infoLines.length,
      debug: debugLines.length,
      timeRange,
      detectedFormat
    };
  }

  /**
   * Detect log format (Java, Python, Node.js, etc.)
   */
  private detectLogFormat(lines: string[]): string {
    const sample = lines.slice(0, Math.min(10, lines.length)).join('\n');

    // Java/Spring Boot
    if (sample.match(/^\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}\.\d{3}\s+(ERROR|INFO|WARN|DEBUG)/m)) {
      return 'Java/Spring Boot';
    }

    // Python logging
    if (sample.match(/^(ERROR|INFO|WARNING|DEBUG):[\w.]+:/m)) {
      return 'Python';
    }

    // Node.js/Winston
    if (sample.match(/"level":"(error|info|warn|debug)"/)) {
      return 'Node.js/Winston (JSON)';
    }

    // AWS CloudWatch format
    if (sample.match(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/m)) {
      return 'AWS CloudWatch';
    }

    // Generic timestamp + level
    if (sample.match(/\[(ERROR|INFO|WARN|DEBUG)\]/i)) {
      return 'Generic';
    }

    return 'Unknown';
  }

  /**
   * Parse a single log line
   */
  private parseLine(line: string): {
    timestamp?: string;
    level?: string;
    message: string;
    isStackTrace: boolean;
  } {
    // Try to extract timestamp
    const timestampMatch = line.match(/^(\d{4}-\d{2}-\d{2}[T\s]\d{2}:\d{2}:\d{2}(?:\.\d{3})?(?:Z|[+-]\d{2}:\d{2})?)/);
    const timestamp = timestampMatch ? timestampMatch[1] : undefined;

    // Try to extract log level
    const levelMatch = line.match(/\b(ERROR|FATAL|CRITICAL|SEVERE|WARN|WARNING|INFO|DEBUG|TRACE)\b/i);
    const level = levelMatch ? levelMatch[1].toUpperCase() : undefined;

    // Check if this is a stack trace line
    const isStackTrace = this.isStackTraceLine(line);

    // Extract message (everything after level or timestamp)
    let message = line;
    if (timestampMatch) {
      message = line.substring(timestampMatch[0].length).trim();
    }
    if (levelMatch && message.includes(levelMatch[0])) {
      message = message.substring(message.indexOf(levelMatch[0]) + levelMatch[0].length).trim();
    }

    return {
      timestamp,
      level,
      message,
      isStackTrace
    };
  }

  /**
   * Check if line is part of a stack trace
   */
  private isStackTraceLine(line: string): boolean {
    const trimmed = line.trim();

    // Java stack trace: at com.example.Class.method(File.java:123)
    if (trimmed.match(/^at\s+[\w.$<>]+\(.*\)/)) {
      return true;
    }

    // Python stack trace: File "/path/file.py", line 123
    if (trimmed.match(/^File ".*", line \d+/)) {
      return true;
    }

    // Node.js stack trace: at Function.method (file.js:123:45) or at file.js:123:45
    // After trim, it just starts with "at "
    if (trimmed.match(/^at\s+/)) {
      return true;
    }

    // Caused by
    if (trimmed.match(/^Caused by:/)) {
      return true;
    }

    return false;
  }

  /**
   * Parse a stack trace line into structured entry
   */
  private parseStackTraceLine(line: string): StackTraceEntry | null {
    const trimmed = line.trim();

    // Java stack trace: at com.example.payment.PaymentService.process(PaymentService.java:142)
    const javaMatch = trimmed.match(/^at\s+([\w.$<>]+)\((.*?):(\d+)\)/);
    if (javaMatch) {
      const fullMethod = javaMatch[1];
      const file = javaMatch[2];
      const lineNum = parseInt(javaMatch[3], 10);

      // Extract class and method
      const lastDotIndex = fullMethod.lastIndexOf('.');
      const className = lastDotIndex > 0 ? fullMethod.substring(0, lastDotIndex) : undefined;
      const method = lastDotIndex > 0 ? fullMethod.substring(lastDotIndex + 1) : fullMethod;

      return {
        file,
        line: lineNum,
        method,
        className,
        rawLine: line
      };
    }

    // Python stack trace: File "/path/to/file.py", line 123, in function_name
    const pythonMatch = trimmed.match(/^File "(.+?)", line (\d+)(?:, in (.+))?/);
    if (pythonMatch) {
      const fullPath = pythonMatch[1];
      const lineNum = parseInt(pythonMatch[2], 10);
      const method = pythonMatch[3]?.trim();

      // Extract just the filename from full path
      const file = fullPath.split('/').pop() || fullPath;

      return {
        file,
        line: lineNum,
        method,
        rawLine: line
      };
    }

    // Node.js stack trace: at PaymentService.process (/path/to/file.js:142:5)
    const nodeMatch = trimmed.match(/^at\s+(?:(.+?)\s+)?\((.+?):(\d+):(\d+)\)|^at\s+(.+?):(\d+):(\d+)/);
    if (nodeMatch) {
      let method, file, lineNum;

      if (nodeMatch[1]) {
        // Format: at ClassName.method (file:line:col)
        method = nodeMatch[1].trim();
        file = nodeMatch[2].split('/').pop() || nodeMatch[2];
        lineNum = parseInt(nodeMatch[3], 10);
      } else if (nodeMatch[5]) {
        // Format: at file:line:col
        file = nodeMatch[5].split('/').pop() || nodeMatch[5];
        lineNum = parseInt(nodeMatch[6], 10);
      } else {
        return null;
      }

      // Extract class if present (e.g., "PaymentService.process" -> class: PaymentService, method: process)
      let className;
      if (method && method.includes('.')) {
        const parts = method.split('.');
        className = parts.slice(0, -1).join('.');
        method = parts[parts.length - 1];
      }

      return {
        file,
        line: lineNum,
        method,
        className,
        rawLine: line
      };
    }

    // If we can't parse it but it looks like a stack trace, return minimal info
    if (this.isStackTraceLine(line)) {
      return {
        file: 'unknown',
        rawLine: line
      };
    }

    return null;
  }

  /**
   * Check if a line is an exception/error message (for pure stack traces)
   */
  private isExceptionLine(line: string): boolean {
    const trimmed = line.trim();

    // Java/Node.js: TypeError, NullPointerException, RuntimeError, etc.
    if (/^\w+Error\b/i.test(trimmed) || /^\w+Exception\b/i.test(trimmed)) {
      return true;
    }

    // Python: Traceback header
    if (/^Traceback \(most recent call last\)/i.test(trimmed)) {
      return true;
    }

    return false;
  }

  /**
   * Group errors by similar messages
   */
  private groupErrors(errorLines: any[], allLines: string[]): ParsedError[] {
    const errorGroups = new Map<string, ParsedError>();

    let currentError: ParsedError | null = null;
    let currentStackTrace: string[] = [];
    let currentStackTraceEntries: StackTraceEntry[] = [];

    for (let i = 0; i < allLines.length; i++) {
      const line = allLines[i];
      const parsed = this.parseLine(line);

      // Check if this is an error line (either has ERROR level OR is an exception/error message)
      const isError = (parsed.level && ['ERROR', 'FATAL', 'CRITICAL', 'SEVERE'].includes(parsed.level)) ||
                      this.isExceptionLine(line);

      if (isError) {
        // Save previous error if exists
        if (currentError) {
          currentError.stackTrace = currentStackTrace.length > 0 ? currentStackTrace : undefined;
          currentError.stackTraceEntries = currentStackTraceEntries.length > 0 ? currentStackTraceEntries : undefined;
          this.addOrUpdateError(errorGroups, currentError);
        }

        // Extract error type
        const errorType = this.extractErrorType(parsed.message);

        // Start new error
        currentError = {
          timestamp: parsed.timestamp,
          level: (parsed.level || 'ERROR') as any, // Default to ERROR for exception lines
          message: errorType || parsed.message.substring(0, 200),
          count: 1,
          samples: [line],
          rawLines: [line],
          stackTrace: undefined,
          stackTraceEntries: undefined
        };

        currentStackTrace = [];
        currentStackTraceEntries = [];
      } else if (parsed.isStackTrace && currentError) {
        // Add to current error's stack trace
        currentStackTrace.push(line.trim());
        currentError.rawLines.push(line);

        // Parse stack trace line into structured entry
        const stackEntry = this.parseStackTraceLine(line);
        if (stackEntry) {
          currentStackTraceEntries.push(stackEntry);
        }
      } else if (currentError) {
        // Non-stack-trace line after error, save current error
        currentError.stackTrace = currentStackTrace.length > 0 ? currentStackTrace : undefined;
        currentError.stackTraceEntries = currentStackTraceEntries.length > 0 ? currentStackTraceEntries : undefined;
        this.addOrUpdateError(errorGroups, currentError);
        currentError = null;
        currentStackTrace = [];
        currentStackTraceEntries = [];
      }
    }

    // Save last error
    if (currentError) {
      currentError.stackTrace = currentStackTrace.length > 0 ? currentStackTrace : undefined;
      currentError.stackTraceEntries = currentStackTraceEntries.length > 0 ? currentStackTraceEntries : undefined;
      this.addOrUpdateError(errorGroups, currentError);
    }

    // Convert map to array and sort by count
    return Array.from(errorGroups.values())
      .sort((a, b) => b.count - a.count);
  }

  /**
   * Extract error type from error message
   */
  private extractErrorType(message: string): string | null {
    // Java exceptions
    const javaMatch = message.match(/\b(\w+Exception|\w+Error)\b/);
    if (javaMatch) {
      return javaMatch[1];
    }

    // Python exceptions
    const pythonMatch = message.match(/^(\w+Error|Exception):/);
    if (pythonMatch) {
      return pythonMatch[1];
    }

    // Node.js errors
    const nodeMatch = message.match(/Error:\s*(.+?)(?:\n|$)/);
    if (nodeMatch) {
      return nodeMatch[1].substring(0, 100);
    }

    // Generic error message
    const genericMatch = message.match(/^([^:]+):/);
    if (genericMatch) {
      return genericMatch[1].substring(0, 100);
    }

    return null;
  }

  /**
   * Add or update error in groups
   */
  private addOrUpdateError(groups: Map<string, ParsedError>, error: ParsedError): void {
    const key = error.message;

    if (groups.has(key)) {
      const existing = groups.get(key)!;
      existing.count++;
      if (existing.samples.length < 3) {
        existing.samples.push(...error.samples);
      }
      existing.rawLines.push(...error.rawLines);

      // Update timestamp to latest
      if (error.timestamp) {
        existing.timestamp = error.timestamp;
      }
    } else {
      groups.set(key, error);
    }
  }

  /**
   * Validate pasted logs - Check if input is actual logs/stack traces, not random text
   */
  public validate(rawLogs: string): { valid: boolean; error?: string } {
    if (!rawLogs || rawLogs.trim().length === 0) {
      return { valid: false, error: 'No logs provided' };
    }

    const lines = rawLogs.split('\n').filter(line => line.trim().length > 0);

    // Check line count (lenient limit - backend has MAX_LENGTH validation)
    if (lines.length > 100000) {
      return {
        valid: false,
        error: `Too many log lines (${lines.length} lines). Please limit to 100,000 lines.`
      };
    }

    // Check if this looks like actual logs or stack traces
    const validationResult = this.isValidLogFormat(lines);

    if (!validationResult.valid) {
      return {
        valid: false,
        error: validationResult.error
      };
    }

    return { valid: true };
  }

  /**
   * Check if the input text looks like actual logs or stack traces
   */
  private isValidLogFormat(lines: string[]): { valid: boolean; error?: string } {
    if (lines.length === 0) {
      return { valid: false, error: 'No log lines provided' };
    }

    // Count lines that match log patterns
    let timestampCount = 0;
    let logLevelCount = 0;
    let stackTraceCount = 0;
    let errorKeywordCount = 0;
    let structuredLogCount = 0;

    // Sample up to 100 lines for validation (for performance)
    const sampleSize = Math.min(lines.length, 100);
    const sampleLines = lines.slice(0, sampleSize);

    console.log(`[Log Validation] Validating ${lines.length} lines (sampling ${sampleSize})`);

    for (const line of sampleLines) {
      const trimmed = line.trim();

      // Skip empty lines
      if (trimmed.length === 0) {
        continue;
      }

      // Check for timestamps (various formats)
      if (/^\d{4}-\d{2}-\d{2}[T\s]/.test(trimmed) || // ISO format: 2025-01-15 or 2025-01-15T
          /^\d{2}\/\d{2}\/\d{4}/.test(trimmed) ||      // US format: 01/15/2025
          /^\w{3}\s+\d{1,2}\s+\d{2}:\d{2}:\d{2}/.test(trimmed) || // Syslog: Jan 15 10:30:45
          /^\d{10,13}/.test(trimmed)) {                // Unix timestamp: 1234567890
        timestampCount++;
      }

      // Check for log levels
      if (/\b(ERROR|FATAL|CRITICAL|SEVERE|WARN|WARNING|INFO|DEBUG|TRACE)\b/i.test(trimmed)) {
        logLevelCount++;
      }

      // Check for stack trace patterns
      if (this.isStackTraceLine(trimmed)) {
        stackTraceCount++;
      }

      // Check for error/exception keywords
      if (/\b(Exception|Error|Caused by|Failed|Failure|Timeout|Connection refused|Cannot|Unable to)\b/i.test(trimmed)) {
        errorKeywordCount++;
      }

      // Check for structured log patterns (JSON, key=value, [service])
      if (/{.*"level".*:.*"(error|info|warn|debug)"/i.test(trimmed) || // JSON logs
          /\[[\w\-]+\]/.test(trimmed) ||                                  // [service-name] or [request-id]
          /\w+=[\w\-\.]+/.test(trimmed)) {                               // key=value pairs
        structuredLogCount++;
      }
    }

    // Calculate match percentages
    const timestampPercent = (timestampCount / sampleSize) * 100;
    const logLevelPercent = (logLevelCount / sampleSize) * 100;
    const stackTracePercent = (stackTraceCount / sampleSize) * 100;
    const errorKeywordPercent = (errorKeywordCount / sampleSize) * 100;
    const structuredLogPercent = (structuredLogCount / sampleSize) * 100;

    console.log(`[Log Validation] Counts:`, {
      timestamps: `${timestampCount}/${sampleSize} (${timestampPercent.toFixed(1)}%)`,
      logLevels: `${logLevelCount}/${sampleSize} (${logLevelPercent.toFixed(1)}%)`,
      stackTraces: `${stackTraceCount}/${sampleSize} (${stackTracePercent.toFixed(1)}%)`,
      errorKeywords: `${errorKeywordCount}/${sampleSize} (${errorKeywordPercent.toFixed(1)}%)`,
      structured: `${structuredLogCount}/${sampleSize} (${structuredLogPercent.toFixed(1)}%)`
    });

    // Validation logic (lenient - backend has stronger validation):
    // Valid if:
    // 1. Has timestamps in >25% of lines (lowered from 40%), OR
    // 2. Has log levels in >20% of lines (lowered from 30%), OR
    // 3. Has stack traces in >10% of lines (lowered from 15%), OR
    // 4. Has error keywords in >20% AND some structure (>10%), OR
    // 5. Has ANY stack traces (>0) AND error keywords (for pure exception dumps), OR
    // 6. Has just 3+ lines with error keywords (fallback for simple error messages)

    const hasTimestamps = timestampPercent > 25;
    const hasLogLevels = logLevelPercent > 20;
    const hasStackTraces = stackTracePercent > 10;
    const hasErrorsWithStructure = errorKeywordPercent > 20 && structuredLogPercent > 10;
    const isPureStackTrace = stackTraceCount > 0 && errorKeywordCount > 0;
    const hasMinimalErrors = errorKeywordCount >= 3 || stackTraceCount >= 3;

    console.log(`[Log Validation] Validation checks:`, {
      hasTimestamps,
      hasLogLevels,
      hasStackTraces,
      hasErrorsWithStructure,
      isPureStackTrace,
      hasMinimalErrors
    });

    if (hasTimestamps || hasLogLevels || hasStackTraces || hasErrorsWithStructure || isPureStackTrace || hasMinimalErrors) {
      // Frontend validation is lenient - backend will do stronger validation
      return { valid: true };
    }

    // If none of the patterns match, it's likely not valid logs
    return {
      valid: false,
      error: 'This doesn\'t appear to be valid log format. Please paste:\n' +
             '• Application error logs with timestamps and error messages\n' +
             '• Stack traces from exceptions\n' +
             '• CloudWatch logs or similar structured logs\n\n' +
             'Make sure to include actual log output, not descriptions or summaries.'
    };
  }

  /**
   * Get example logs for demo
   */
  public static getExampleLogs(): string {
    return `2025-10-25 12:00:01.234 INFO  [payment-processor] Processing payment request id=pay_123
2025-10-25 12:00:02.456 INFO  [payment-processor] Validating payment details
2025-10-25 12:00:03.789 ERROR [payment-processor] NullPointerException: Customer ID cannot be null
	at com.example.payment.PaymentService.process(PaymentService.java:142)
	at com.example.payment.PaymentController.checkout(PaymentController.java:78)
	at jdk.internal.reflect.NativeMethodAccessorImpl.invoke0(Native Method)
	at java.base/jdk.internal.reflect.NativeMethodAccessorImpl.invoke(NativeMethodAccessorImpl.java:77)
2025-10-25 12:00:04.012 ERROR [payment-processor] Payment processing failed for order ord_456
2025-10-25 12:00:05.234 INFO  [payment-processor] Retrying payment with exponential backoff
2025-10-25 12:00:07.456 ERROR [payment-processor] NullPointerException: Customer ID cannot be null
	at com.example.payment.PaymentService.process(PaymentService.java:142)
	at com.example.payment.PaymentController.checkout(PaymentController.java:78)
2025-10-25 12:00:08.789 WARN  [payment-processor] Max retry attempts reached for payment pay_123
2025-10-25 12:00:09.012 ERROR [payment-processor] Failed to process payment after 3 retries
2025-10-25 12:00:10.234 ERROR [payment-processor] NullPointerException: Customer ID cannot be null
	at com.example.payment.PaymentService.process(PaymentService.java:142)
2025-10-25 12:00:12.456 INFO  [payment-processor] Payment marked as failed in database
2025-10-25 12:00:13.789 ERROR [payment-processor] TimeoutException: Database connection timeout after 30s
	at com.example.database.ConnectionPool.getConnection(ConnectionPool.java:89)
	at com.example.payment.PaymentRepository.save(PaymentRepository.java:45)
2025-10-25 12:00:15.012 ERROR [payment-processor] TimeoutException: Database connection timeout after 30s
	at com.example.database.ConnectionPool.getConnection(ConnectionPool.java:89)`;
  }
}
