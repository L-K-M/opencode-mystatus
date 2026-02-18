#!/usr/bin/env node
/**
 * Standalone CLI script to check AI quota status
 * Run with: bun run cli.ts or npx tsx cli.ts
 */

import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import chalk from "chalk";
import { program } from "commander";

import {
  REQUEST_TIMEOUT_MS,
  type AuthData,
  type QueryResult,
} from "./plugin/lib/types";
import { queryOpenAIUsage } from "./plugin/lib/openai";
import { queryZaiUsage, queryZhipuUsage } from "./plugin/lib/zhipu";
import { queryGoogleUsage } from "./plugin/lib/google";
import { queryCopilotUsage } from "./plugin/lib/copilot";

// ============================================================================
// Global State
// ============================================================================

let isRunning = true;
let nextUpdateTime: Date | null = null;

interface DashboardConfig {
  showHeader: boolean;
  showSummary: boolean;
  showAccountQuota: boolean;
  showFooter: boolean;
  maxWidth?: number;
}

const DEFAULT_WIDTH = 80;
const MIN_WIDTH = 20;
const ANSI_ESCAPE = "\u001b";
const ZAI_QUOTA_QUERY_URL = "https://api.z.ai/api/monitor/usage/quota/limit";

interface ZaiDerivedTokenUsage {
  used: number;
  total: number;
}

const ZAI_USED_FIELDS = [
  "currentValue",
  "current_value",
  "used",
  "usedValue",
  "used_value",
];

const ZAI_TOTAL_FIELDS = [
  "usage",
  "total",
  "limit",
  "quota",
  "max",
  "entitlement",
  "totalValue",
  "total_value",
];

const COPILOT_QUOTA_LINE_REGEX =
  /^(.+?)\s+([█░]+)\s+(\d+)%\s+\(\s*([^/)]+?)\s*\/\s*([^)]+?)\s*\)\s*$/;
const COPILOT_UNLIMITED_LINE_REGEX = /^(.+?)\s+Unlimited\s*$/i;
const COPILOT_RESET_LINE_REGEX = /^(Quota resets|配额重置)\s*[:：]\s*(.+)$/i;
const USED_LINE_REGEX = /^\s*(Used:|已用[:：])/;
const RESET_LINE_REGEX = /^\s*(Resets in:|Quota resets:|重置[:：])/;

// ============================================================================
// Utility Functions
// ============================================================================

function clearScreen(full: boolean = false) {
  if (full) {
    process.stdout.write("\x1b[2J\x1b[H");
    return;
  }

  // Move cursor to home position without clearing
  // This prevents the blank/flicker effect
  process.stdout.write("\x1b[H");
}

function clearToEndOfScreen() {
  // Clear from cursor to end of screen
  // This removes any leftover content from previous renders
  process.stdout.write("\x1b[J");
}

function getTimeUntilNextUpdate(): string {
  if (!nextUpdateTime) return "";

  const now = new Date();
  const diff = Math.max(0, Math.floor((nextUpdateTime.getTime() - now.getTime()) / 1000));

  const minutes = Math.floor(diff / 60);
  const seconds = diff % 60;

  if (minutes > 0) {
    return `${minutes}m ${seconds}s`;
  }
  return `${seconds}s`;
}

function getTerminalWidth(): number {
  if (typeof process.stdout.columns === "number" && process.stdout.columns > 0) {
    return process.stdout.columns;
  }

  return DEFAULT_WIDTH;
}

function getRenderWidth(maxWidth?: number): number {
  const terminalWidth = getTerminalWidth();

  if (!maxWidth) {
    return terminalWidth;
  }

  const minWidth = Math.min(MIN_WIDTH, terminalWidth);
  return Math.max(minWidth, Math.min(maxWidth, terminalWidth));
}

function stripAnsi(text: string): string {
  let result = "";

  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === ANSI_ESCAPE && text[i + 1] === "[") {
      i += 2;
      while (i < text.length && text[i] !== "m") {
        i += 1;
      }
      continue;
    }

    result += text[i];
  }

  return result;
}

function fitLineToWidth(line: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  if (stripAnsi(line).length <= width) {
    return line;
  }

  const ellipsis = "...";
  const targetLength = Math.max(0, width - ellipsis.length);
  let visibleChars = 0;
  let index = 0;
  let result = "";

  while (index < line.length && visibleChars < targetLength) {
    if (line[index] === ANSI_ESCAPE && line[index + 1] === "[") {
      let ansiEndIndex = index + 2;
      while (ansiEndIndex < line.length && line[ansiEndIndex] !== "m") {
        ansiEndIndex += 1;
      }

      if (ansiEndIndex < line.length) {
        result += line.slice(index, ansiEndIndex + 1);
        index = ansiEndIndex + 1;
        continue;
      }
    }

    result += line[index];
    index += 1;
    visibleChars += 1;
  }

  if (result.includes(`${ANSI_ESCAPE}[`)) {
    result += `${ANSI_ESCAPE}[0m`;
  }

  return result + ellipsis;
}

function centerText(text: string, width: number): string {
  if (width <= 0) {
    return "";
  }

  let displayText = text;
  if (displayText.length > width) {
    if (width <= 3) {
      displayText = ".".repeat(width);
    } else {
      displayText = displayText.slice(0, width - 3) + "...";
    }
  }

  const totalPadding = Math.max(0, width - displayText.length);
  const leftPadding = Math.floor(totalPadding / 2);
  const rightPadding = totalPadding - leftPadding;

  return " ".repeat(leftPadding) + displayText + " ".repeat(rightPadding);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseNumericValue(value: unknown): number | null {
  if (typeof value === "number") {
    return Number.isFinite(value) ? value : null;
  }

  if (typeof value !== "string") {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const normalized = trimmed.replace(/,/g, "");
  const direct = Number(normalized);
  if (Number.isFinite(direct)) {
    return direct;
  }

  const leadingNumberMatch = normalized.match(/^-?\d+(?:\.\d+)?/);
  if (!leadingNumberMatch) {
    return null;
  }

  const parsed = Number(leadingNumberMatch[0]);
  return Number.isFinite(parsed) ? parsed : null;
}

function pickFirstNumericValue(
  record: Record<string, unknown>,
  keys: readonly string[],
): number | null {
  for (const key of keys) {
    if (!Object.prototype.hasOwnProperty.call(record, key)) {
      continue;
    }

    const parsed = parseNumericValue(record[key]);
    if (parsed !== null) {
      return parsed;
    }
  }

  return null;
}

async function fetchDerivedZaiTokenUsage(
  zaiAuth: AuthData["zai-coding-plan"],
): Promise<ZaiDerivedTokenUsage | null> {
  if (!zaiAuth || zaiAuth.type !== "api" || !zaiAuth.key) {
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const response = await fetch(ZAI_QUOTA_QUERY_URL, {
      method: "GET",
      headers: {
        Authorization: zaiAuth.key,
        "Content-Type": "application/json",
        "User-Agent": "OpenCode-Status-Plugin/1.0",
      },
      signal: controller.signal,
    });

    if (!response.ok) {
      return null;
    }

    const payload = (await response.json()) as unknown;
    if (!isRecord(payload)) {
      return null;
    }

    const isSuccess = payload.success === true;
    const responseCode = parseNumericValue(payload.code);
    if (!isSuccess || responseCode !== 200) {
      return null;
    }

    const data = payload.data;
    if (!isRecord(data) || !Array.isArray(data.limits)) {
      return null;
    }

    const tokensLimit = data.limits.find(
      (item): item is Record<string, unknown> =>
        isRecord(item) && item.type === "TOKENS_LIMIT",
    );

    if (!tokensLimit) {
      return null;
    }

    const explicitUsed = pickFirstNumericValue(tokensLimit, ZAI_USED_FIELDS);
    const explicitTotal = pickFirstNumericValue(tokensLimit, ZAI_TOTAL_FIELDS);

    if (
      explicitUsed !== null &&
      explicitTotal !== null &&
      Number.isFinite(explicitTotal) &&
      explicitTotal > 0
    ) {
      return {
        used: Math.max(0, Math.min(Math.round(explicitUsed), Math.round(explicitTotal))),
        total: Math.round(explicitTotal),
      };
    }

    const usedPercent = parseNumericValue(tokensLimit.percentage);
    if (usedPercent === null) {
      return null;
    }

    const safePercent = Math.max(0, Math.min(100, usedPercent));
    const roundedTotal = 100;
    const roundedUsed = Math.round(safePercent);

    return {
      used: roundedUsed,
      total: roundedTotal,
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

function injectDerivedZaiUsage(
  content: string,
  usage: ZaiDerivedTokenUsage | null,
): string {
  if (!usage) {
    return content;
  }

  const lines = content.split("\n");
  const tokenLimitHeaderRegex = /(token limit|Token 限额)/i;
  const mcpHeaderRegex = /(MCP monthly quota|MCP 月度配额)/i;
  const usedLineRegex = /^\s*(Used:|已用[:：])/;

  const tokenSectionIndex = lines.findIndex((line) =>
    tokenLimitHeaderRegex.test(line),
  );
  if (tokenSectionIndex === -1) {
    return content;
  }

  let usedLineIndex = -1;
  for (let i = tokenSectionIndex + 1; i < lines.length; i += 1) {
    const trimmed = lines[i].trim();

    if (!trimmed) {
      if (i > tokenSectionIndex + 1) {
        break;
      }
      continue;
    }

    if (mcpHeaderRegex.test(trimmed)) {
      break;
    }

    if (usedLineRegex.test(trimmed)) {
      usedLineIndex = i;
      break;
    }
  }

  if (usedLineIndex !== -1 && !/NaN|N\/A/i.test(lines[usedLineIndex])) {
    return content;
  }

  const indentSource =
    usedLineIndex !== -1
      ? lines[usedLineIndex]
      : (lines[Math.min(tokenSectionIndex + 1, lines.length - 1)] ?? "");
  const indentMatch = indentSource.match(/^\s*/);
  const indent = indentMatch ? indentMatch[0] : "  ";
  const usedLabel = content.includes("已用") ? "已用:" : "Used:";
  const derivedLine = `${indent}${usedLabel} ${usage.used} / ${usage.total}`;

  if (usedLineIndex !== -1) {
    lines[usedLineIndex] = derivedLine;
  } else {
    const insertIndex = Math.min(tokenSectionIndex + 2, lines.length);
    lines.splice(insertIndex, 0, derivedLine);
  }

  return lines.join("\n");
}

function withDerivedZaiUsage(
  result: QueryResult | null,
  usage: ZaiDerivedTokenUsage | null,
): QueryResult | null {
  if (!result || !result.success || !result.output || !usage) {
    return result;
  }

  return {
    ...result,
    output: injectDerivedZaiUsage(result.output, usage),
  };
}

function inlineResetIntoUsedLine(content: string): string {
  const lines = content.split("\n");

  for (let i = 0; i < lines.length; i += 1) {
    const currentTrimmed = lines[i].trim();
    if (!USED_LINE_REGEX.test(currentTrimmed)) {
      continue;
    }

    if (RESET_LINE_REGEX.test(currentTrimmed)) {
      continue;
    }

    let nextLineIndex = i + 1;
    while (nextLineIndex < lines.length && lines[nextLineIndex].trim() === "") {
      nextLineIndex += 1;
    }

    if (nextLineIndex >= lines.length) {
      continue;
    }

    const resetText = lines[nextLineIndex].trim();
    if (!RESET_LINE_REGEX.test(resetText)) {
      continue;
    }

    lines[i] = `${currentTrimmed} • ${resetText}`;
    lines.splice(nextLineIndex, 1);
  }

  return lines.join("\n");
}

function withNormalizedZaiLayout(
  result: QueryResult | null,
): QueryResult | null {
  if (!result || !result.success || !result.output) {
    return result;
  }

  return {
    ...result,
    output: inlineResetIntoUsedLine(result.output),
  };
}

function createTextProgressBar(percent: number, width: number = 30): string {
  const safePercent = Math.max(0, Math.min(100, percent));
  const filled = Math.round((safePercent / 100) * width);
  const empty = width - filled;
  return "█".repeat(filled) + "░".repeat(empty);
}

function normalizeCopilotContent(content: string): string {
  const lines = content.split("\n");

  let resetLineIndex = -1;
  let resetCountdown: string | null = null;

  for (let i = 0; i < lines.length; i += 1) {
    const resetMatch = lines[i].trim().match(COPILOT_RESET_LINE_REGEX);
    if (!resetMatch) {
      continue;
    }

    resetLineIndex = i;
    const countdownWithDate = resetMatch[2].trim();
    resetCountdown = countdownWithDate.split(" (")[0].trim();
    break;
  }

  const normalized: string[] = [];
  let resetInlineAdded = false;
  let previousWasQuotaBlock = false;

  for (let i = 0; i < lines.length; i += 1) {
    if (i === resetLineIndex) {
      continue;
    }

    const originalLine = lines[i];
    const trimmed = originalLine.trim();

    const quotaMatch = trimmed.match(COPILOT_QUOTA_LINE_REGEX);
    if (quotaMatch) {
      const label = quotaMatch[1].trim();
      const percent = parseInt(quotaMatch[3], 10);
      const used = quotaMatch[4].trim();
      const total = quotaMatch[5].trim();

      if (previousWasQuotaBlock && normalized[normalized.length - 1] !== "") {
        normalized.push("");
      }

      const bar = createTextProgressBar(percent, 30);
      let usedLine = `Used: ${used} / ${total}`;
      if (resetCountdown && !resetInlineAdded) {
        usedLine += ` • Resets in: ${resetCountdown}`;
        resetInlineAdded = true;
      }

      normalized.push(label);
      normalized.push(`${bar} ${percent}% remaining`);
      normalized.push(usedLine);
      previousWasQuotaBlock = true;
      continue;
    }

    const unlimitedMatch = trimmed.match(COPILOT_UNLIMITED_LINE_REGEX);
    if (unlimitedMatch) {
      const label = unlimitedMatch[1].trim();

      if (previousWasQuotaBlock && normalized[normalized.length - 1] !== "") {
        normalized.push("");
      }

      normalized.push(label);
      normalized.push("Unlimited");
      previousWasQuotaBlock = true;
      continue;
    }

    normalized.push(originalLine);
    previousWasQuotaBlock = false;
  }

  const compacted: string[] = [];
  for (const line of normalized) {
    const isBlank = line.trim() === "";
    const previousBlank =
      compacted.length > 0 && compacted[compacted.length - 1].trim() === "";

    if (isBlank && (compacted.length === 0 || previousBlank)) {
      continue;
    }

    compacted.push(line);
  }

  while (
    compacted.length > 0 &&
    compacted[compacted.length - 1].trim() === ""
  ) {
    compacted.pop();
  }

  return compacted.join("\n");
}

function withNormalizedCopilotLayout(
  result: QueryResult | null,
): QueryResult | null {
  if (!result || !result.success || !result.output) {
    return result;
  }

  return {
    ...result,
    output: normalizeCopilotContent(result.output),
  };
}

// ============================================================================
// Dashboard Styling Functions
// ============================================================================

function createDashboardHeader(width: number, watchMode: boolean = false, interval?: number) {
  const safeWidth = Math.max(4, width);
  const contentWidth = safeWidth - 2;
  const title = "AI ACCOUNT QUOTA DASHBOARD";
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  console.log(chalk.bold.cyan("┌" + "─".repeat(contentWidth) + "┐"));
  console.log(
    chalk.bold.cyan("│") +
      chalk.bold.white(centerText(title, contentWidth)) +
      chalk.bold.cyan("│")
  );
  console.log(
    chalk.bold.cyan("│") +
      chalk.gray(centerText(date, contentWidth)) +
      chalk.bold.cyan("│")
  );

  if (watchMode && interval) {
    const modeText = `🔄 Watch Mode • Updating every ${interval} minute${interval !== 1 ? 's' : ''}`;
    console.log(
      chalk.bold.cyan("│") +
        chalk.yellow(centerText(modeText, contentWidth)) +
        chalk.bold.cyan("│")
    );
  }

  console.log(chalk.bold.cyan("└" + "─".repeat(contentWidth) + "┘"));
  console.log();
}

function createSectionBox(title: string, icon: string, width: number) {
  console.log();
  console.log(fitLineToWidth(chalk.bold.white(`${icon}  ${title}`), width));
  console.log(chalk.gray("─".repeat(width)));
}

function formatProgressBar(text: string): string {
  // Colorize progress bars based on percentage
  const percentMatch = text.match(/(\d+)%/);
  const percent = percentMatch ? parseInt(percentMatch[1]) : 0;

  // Replace the box characters with colored ones
  let colored = text;

  if (percent >= 70) {
    // Green for healthy (70-100%)
    colored = colored.replace(/█/g, chalk.green("█"));
    colored = colored.replace(/░/g, chalk.gray("░"));
  } else if (percent >= 40) {
    // Yellow for moderate (40-69%)
    colored = colored.replace(/█/g, chalk.yellow("█"));
    colored = colored.replace(/░/g, chalk.gray("░"));
  } else {
    // Red for low (0-39%)
    colored = colored.replace(/█/g, chalk.red("█"));
    colored = colored.replace(/░/g, chalk.gray("░"));
  }

  // Color the percentage
  if (percent >= 70) {
    colored = colored.replace(/(\d+)% remaining/, chalk.green.bold("$1%") + chalk.white(" remaining"));
  } else if (percent >= 40) {
    colored = colored.replace(/(\d+)% remaining/, chalk.yellow.bold("$1%") + chalk.white(" remaining"));
  } else {
    colored = colored.replace(/(\d+)% remaining/, chalk.red.bold("$1%") + chalk.white(" remaining"));
  }

  return colored;
}

function formatOutputContent(content: string, width: number): string {
  const lines = content.split("\n");
  const formatted: string[] = [];

  for (let line of lines) {
    const trimmed = line.trim();

    // Skip empty lines
    if (!trimmed) {
      formatted.push("");
      continue;
    }

    // Color account info
    if (line.startsWith("Account:")) {
      const parts = line.split(":");
      line = "  " + chalk.cyan.bold("Account:") + chalk.white(parts[1]);
    }
    // Color limit/quota headers (bold magenta)
    else if (
      trimmed.includes("limit") ||
      trimmed.includes("quota") ||
      /^(Premium|Chat|Completions)$/i.test(trimmed)
    ) {
      line = "  " + chalk.magenta.bold(trimmed);
    }
    // Color progress bars
    else if (line.includes("█") || line.includes("░")) {
      line = "  " + formatProgressBar(line.trim());
    }
    // Color "Used:" lines
    else if (trimmed.includes("Used:") || trimmed.includes("已用")) {
      let styled = trimmed.replace(/Used:/, chalk.yellow("Used:"));
      styled = styled.replace(/已用[:：]/, match => chalk.yellow(match));
      styled = styled.replace(
        /(Resets in:|Quota resets:|重置[:：])/,
        chalk.blue.bold("$1"),
      );
      line = "  " + styled;
    }
    // Color reset time
    else if (trimmed.includes("Resets in:") || trimmed.includes("Quota resets:") || trimmed.includes("重置")) {
      line = "  " + trimmed.replace(/(Resets in:|Quota resets:|重置[:：])/, chalk.blue.bold("$1"));
    }
    // Color warnings
    else if (trimmed.includes("⚠️")) {
      line = "  " + chalk.yellow(trimmed);
    }
    // Regular lines with indentation
    else {
      line = "  " + chalk.gray(trimmed);
    }

    formatted.push(fitLineToWidth(line, width));
  }

  return formatted.join("\n");
}

function collectResult(
  result: QueryResult | null,
  title: string,
  icon: string,
  results: Array<{ title: string; icon: string; content: string }>,
  errors: string[],
): void {
  if (!result) {
    return;
  }
  if (result.success && result.output) {
    results.push({ title, icon, content: result.output });
  } else if (!result.success && result.error) {
    // Silently ignore "file not found" errors (ENOENT) - these indicate unconfigured services
    // This matches the behavior where null results are silently ignored
    if (result.error.includes("ENOENT") || result.error.includes("no such file")) {
      return;
    }
    errors.push(result.error);
  }
}

async function fetchAndDisplayQuotas(
  watchMode: boolean = false,
  interval?: number,
  config: DashboardConfig = {
    showHeader: true,
    showSummary: true,
    showAccountQuota: true,
    showFooter: true,
  },
) {
  const renderWidth = getRenderWidth(config.maxWidth);

  if (watchMode) {
    // In watch mode, fully clear before each redraw to avoid visual overlap.
    clearScreen(true);
  }

  if (config.showHeader) {
    createDashboardHeader(renderWidth, watchMode, interval);
  }

  // 1. Read auth.json
  const authPath = join(homedir(), ".local/share/opencode/auth.json");
  let authData: AuthData;

  try {
    const content = await readFile(authPath, "utf-8");
    authData = JSON.parse(content);
  } catch (err) {
    const errorLines = [
      chalk.red.bold("❌ Error reading auth file"),
      chalk.gray(authPath),
      chalk.yellow(err instanceof Error ? err.message : String(err)),
    ];

    console.log();
    for (const line of errorLines) {
      console.log(fitLineToWidth(line, renderWidth));
    }

    if (!watchMode) {
      process.exit(1);
    }
    return;
  }

  // 2. Query all platforms in parallel
  console.log(fitLineToWidth(chalk.gray("⟳ Querying all platforms..."), renderWidth));
  console.log();

  const [
    openaiResult,
    zhipuResult,
    rawZaiResult,
    googleResult,
    copilotResult,
    zaiDerivedTokenUsage,
  ] =
    await Promise.all([
      queryOpenAIUsage(authData.openai),
      queryZhipuUsage(authData["zhipuai-coding-plan"]),
      queryZaiUsage(authData["zai-coding-plan"]),
      queryGoogleUsage(),
      queryCopilotUsage(authData["github-copilot"]),
      fetchDerivedZaiTokenUsage(authData["zai-coding-plan"]),
    ]);

  const zaiResult = withNormalizedZaiLayout(
    withDerivedZaiUsage(rawZaiResult, zaiDerivedTokenUsage),
  );
  const normalizedCopilotResult = withNormalizedCopilotLayout(copilotResult);

  // 3. Collect results
  const results: Array<{ title: string; icon: string; content: string }> = [];
  const errors: string[] = [];

  collectResult(openaiResult, "OpenAI Account Quota", "🤖", results, errors);
  collectResult(zhipuResult, "Zhipu AI Account Quota", "🧠", results, errors);
  collectResult(zaiResult, "Z.ai Account Quota", "⚡", results, errors);
  collectResult(googleResult, "Google Cloud Account Quota", "☁️", results, errors);
  collectResult(normalizedCopilotResult, "GitHub Copilot Account Quota", "🚀", results, errors);

  // 4. Output results
  if (results.length === 0 && errors.length === 0) {
    console.log();
    console.log(fitLineToWidth(chalk.yellow.bold("⚠️  No configured accounts found"), renderWidth));
    console.log();
    console.log(fitLineToWidth(chalk.gray("Supported platforms:"), renderWidth));
    console.log(fitLineToWidth(chalk.gray("  • OpenAI (Plus/Team/Pro subscriptions)"), renderWidth));
    console.log(fitLineToWidth(chalk.gray("  • Zhipu AI (Coding Plan)"), renderWidth));
    console.log(fitLineToWidth(chalk.gray("  • Z.ai (Coding Plan)"), renderWidth));
    console.log(fitLineToWidth(chalk.gray("  • Google Cloud (Antigravity)"), renderWidth));
    console.log(fitLineToWidth(chalk.gray("  • GitHub Copilot"), renderWidth));

    if (!watchMode) {
      process.exit(0);
    }
    return;
  }

  if (config.showSummary) {
    console.log(fitLineToWidth(chalk.bold.white("📊 Summary"), renderWidth));
    console.log();
    console.log(fitLineToWidth(chalk.gray("  Active platforms: ") + chalk.green.bold(results.length), renderWidth));

    for (const result of results) {
      // Extract all percentages from content
      const percentMatches = result.content.match(/(\d+)%/g);
      let lowestPercent: number | null = null;

      if (percentMatches) {
        const percents = percentMatches.map(m => parseInt(m.replace("%", "")));
        lowestPercent = Math.min(...percents);
      }

      let statusIcon = "●";
      let statusColor = chalk.gray;
      let statusText = "";

      if (lowestPercent !== null) {
        if (lowestPercent >= 70) {
          statusIcon = "●";
          statusColor = chalk.green;
          statusText = chalk.green(`(${lowestPercent}%)`);
        } else if (lowestPercent >= 40) {
          statusIcon = "●";
          statusColor = chalk.yellow;
          statusText = chalk.yellow(`(${lowestPercent}%)`);
        } else {
          statusIcon = "●";
          statusColor = chalk.red;
          statusText = chalk.red.bold(`(${lowestPercent}% ⚠️)`);
        }
      }

      console.log(
        fitLineToWidth(
          "  " + statusColor(statusIcon) + " " +
            chalk.white(result.icon + " " + result.title.replace(" Account Quota", "")) +
            " " + statusText,
          renderWidth,
        ),
      );
    }

    console.log();
  }

  // Display detailed results
  if (config.showAccountQuota) {
    for (const result of results) {
      createSectionBox(result.title, result.icon, renderWidth);
      console.log(formatOutputContent(result.content, renderWidth));
    }
  }

  // Display errors if any
  if (errors.length > 0) {
    console.log();
    console.log(fitLineToWidth(chalk.red.bold("❌ Errors occurred:"), renderWidth));
    console.log(chalk.gray("─".repeat(renderWidth)));

    for (const error of errors) {
      console.log(fitLineToWidth(chalk.red("  • " + error), renderWidth));
    }
  }

  // Footer
  if (config.showFooter) {
    console.log();
    console.log(chalk.gray("─".repeat(renderWidth)));

    const footerParts = [
      chalk.gray("  Last updated: ") + chalk.white(new Date().toLocaleTimeString()),
    ];

    if (watchMode && nextUpdateTime) {
      footerParts.push(
        chalk.gray("  Next update in: ") + chalk.cyan(getTimeUntilNextUpdate()),
      );
    }

    if (watchMode) {
      footerParts.push(chalk.gray("  Press Ctrl+C to exit"));
    }

    console.log(fitLineToWidth(footerParts.join(chalk.gray(" • ")), renderWidth));
    console.log();
  }

  // Clear any remaining content from previous render
  if (watchMode) {
    clearToEndOfScreen();
  }
}

async function main() {
  // Parse command line arguments
  program
    .name("mystatus")
    .description("Monitor AI account quotas in a beautiful dashboard")
    .option("-w, --watch", "Watch mode: continuously poll and update", false)
    .option("-i, --interval <minutes>", "Polling interval in minutes (default: 5)", "5")
    .option(
      "--show <sections>",
      "Comma-separated sections to show: header,summary,dashboard,footer",
    )
    .option("--width <columns>", "Set max dashboard width (default: auto-detect terminal width)")
    .parse();

  const options = program.opts<{
    watch: boolean;
    interval: string;
    show?: string;
    width?: string;
  }>();

  const watchMode = options.watch;
  const interval = parseInt(options.interval, 10);

  if (isNaN(interval) || interval < 1) {
    console.error(chalk.red("Error: Interval must be a positive number"));
    process.exit(1);
  }

  let maxWidth: number | undefined;
  if (typeof options.width === "string") {
    maxWidth = parseInt(options.width, 10);
    if (isNaN(maxWidth) || maxWidth < MIN_WIDTH) {
      console.error(chalk.red(`Error: Width must be a number >= ${MIN_WIDTH}`));
      process.exit(1);
    }
  }

  const config: DashboardConfig = {
    showHeader: true,
    showSummary: true,
    showAccountQuota: true,
    showFooter: true,
    maxWidth,
  };

  if (typeof options.show === "string") {
    const sections = options.show
      .split(",")
      .map(section => section.trim().toLowerCase())
      .filter(section => section.length > 0);

    if (sections.length === 0) {
      console.error(chalk.red("Error: --show must include at least one section"));
      process.exit(1);
    }

    config.showHeader = false;
    config.showSummary = false;
    config.showAccountQuota = false;
    config.showFooter = false;

    const unknownSections: string[] = [];

    for (const section of sections) {
      switch (section) {
        case "header":
          config.showHeader = true;
          break;
        case "summary":
          config.showSummary = true;
          break;
        case "dashboard":
        case "account-quota":
        case "accountquota":
          config.showAccountQuota = true;
          break;
        case "footer":
          config.showFooter = true;
          break;
        default:
          unknownSections.push(section);
          break;
      }
    }

    if (unknownSections.length > 0) {
      console.error(
        chalk.red(
          `Error: Unknown section(s): ${unknownSections.join(", ")}. Valid values: header,summary,dashboard,footer`,
        ),
      );
      process.exit(1);
    }
  }

  clearScreen(true);

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log(chalk.yellow("\n\n👋 Shutting down dashboard..."));
    isRunning = false;
    process.exit(0);
  });

  if (!watchMode) {
    // Single run mode
    await fetchAndDisplayQuotas(false, undefined, config);
  } else {
    // Watch mode - continuous polling
    // Initial fetch
    await fetchAndDisplayQuotas(true, interval, config);

    // Set up polling
    const intervalMs = interval * 60 * 1000;

    const poll = async () => {
      if (!isRunning) return;

      nextUpdateTime = new Date(Date.now() + intervalMs);

      let countdownInterval: NodeJS.Timeout | undefined;

      if (config.showFooter) {
        // Update countdown every second
        countdownInterval = setInterval(() => {
          if (!isRunning) {
            if (countdownInterval) {
              clearInterval(countdownInterval);
            }
            return;
          }

          // Move cursor up to update the footer
          process.stdout.write("\x1b[2A"); // Move up 2 lines
          process.stdout.write("\x1b[K"); // Clear line

          const footerParts = [
            chalk.gray("  Last updated: ") + chalk.white(new Date().toLocaleTimeString()),
            chalk.gray("  Next update in: ") + chalk.cyan(getTimeUntilNextUpdate()),
            chalk.gray("  Press Ctrl+C to exit"),
          ];

          console.log(fitLineToWidth(footerParts.join(chalk.gray(" • ")), getRenderWidth(config.maxWidth)));
          console.log();
        }, 1000);
      }

      // Wait for the interval, then fetch again
      await new Promise(resolve => setTimeout(resolve, intervalMs));

      if (countdownInterval) {
        clearInterval(countdownInterval);
      }

      if (isRunning) {
        await fetchAndDisplayQuotas(true, interval, config);
        poll(); // Schedule next poll
      }
    };

    poll();
  }
}

main().catch((err) => {
  console.error("Error:", err);
  process.exit(1);
});
