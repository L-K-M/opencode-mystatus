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

import { type AuthData, type QueryResult } from "./plugin/lib/types";
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
    else if (trimmed.includes("limit") || trimmed.includes("quota")) {
      line = "  " + chalk.magenta.bold(trimmed);
    }
    // Color progress bars
    else if (line.includes("█") || line.includes("░")) {
      line = "  " + formatProgressBar(line.trim());
    }
    // Color reset time
    else if (trimmed.includes("Resets in:") || trimmed.includes("Quota resets:")) {
      line = "  " + trimmed.replace(/(Resets in:|Quota resets:)/, chalk.blue.bold("$1"));
    }
    // Color "Used:" lines
    else if (trimmed.includes("Used:")) {
      line = "  " + trimmed.replace(/Used:/, chalk.yellow("Used:"));
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
    clearScreen();
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

  const [openaiResult, zhipuResult, zaiResult, googleResult, copilotResult] =
    await Promise.all([
      queryOpenAIUsage(authData.openai),
      queryZhipuUsage(authData["zhipuai-coding-plan"]),
      queryZaiUsage(authData["zai-coding-plan"]),
      queryGoogleUsage(),
      queryCopilotUsage(authData["github-copilot"]),
    ]);

  // 3. Collect results
  const results: Array<{ title: string; icon: string; content: string }> = [];
  const errors: string[] = [];

  collectResult(openaiResult, "OpenAI Account Quota", "🤖", results, errors);
  collectResult(zhipuResult, "Zhipu AI Account Quota", "🧠", results, errors);
  collectResult(zaiResult, "Z.ai Account Quota", "⚡", results, errors);
  collectResult(googleResult, "Google Cloud Account Quota", "☁️", results, errors);
  collectResult(copilotResult, "GitHub Copilot Account Quota", "🚀", results, errors);

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
