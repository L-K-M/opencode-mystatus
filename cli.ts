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

import { t } from "./plugin/lib/i18n";
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

// ============================================================================
// Utility Functions
// ============================================================================

function clearScreen() {
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

// ============================================================================
// Dashboard Styling Functions
// ============================================================================

function createDashboardHeader(watchMode: boolean = false, interval?: number) {
  const width = 80;
  const title = "AI ACCOUNT QUOTA DASHBOARD";
  const date = new Date().toLocaleDateString("en-US", {
    weekday: "short",
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });

  console.log(chalk.bold.cyan("┌" + "─".repeat(width - 2) + "┐"));
  console.log(
    chalk.bold.cyan("│") +
      chalk.bold.white(title.padStart((width + title.length) / 2 - 1).padEnd(width - 2)) +
      chalk.bold.cyan("│")
  );
  console.log(
    chalk.bold.cyan("│") +
      chalk.gray(date.padStart((width + date.length) / 2 - 1).padEnd(width - 2)) +
      chalk.bold.cyan("│")
  );

  if (watchMode && interval) {
    const modeText = `🔄 Watch Mode • Updating every ${interval} minute${interval !== 1 ? 's' : ''}`;
    console.log(
      chalk.bold.cyan("│") +
        chalk.yellow(modeText.padStart((width + modeText.length) / 2 - 1).padEnd(width - 2)) +
        chalk.bold.cyan("│")
    );
  }

  console.log(chalk.bold.cyan("└" + "─".repeat(width - 2) + "┘"));
  console.log();
}

function createSectionBox(title: string, icon: string) {
  console.log(
    chalk.bold.white(`\n${icon}  ${title}`)
  );
  console.log(chalk.gray("─".repeat(78)));
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

function formatOutputContent(content: string): string {
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

    formatted.push(line);
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

async function fetchAndDisplayQuotas(watchMode: boolean = false, interval?: number) {
  if (watchMode) {
    clearScreen();
  }

  createDashboardHeader(watchMode, interval);

  // 1. Read auth.json
  const authPath = join(homedir(), ".local/share/opencode/auth.json");
  let authData: AuthData;

  try {
    const content = await readFile(authPath, "utf-8");
    authData = JSON.parse(content);
  } catch (err) {
    console.log(
      chalk.red.bold("❌ Error reading auth file\n") +
      chalk.gray(authPath) + "\n" +
      chalk.yellow(err instanceof Error ? err.message : String(err))
    );
    if (!watchMode) {
      process.exit(1);
    }
    return;
  }

  // 2. Query all platforms in parallel
  console.log(chalk.gray("⟳ Querying all platforms...\n"));
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
    console.log(chalk.yellow.bold("\n⚠️  No configured accounts found\n"));
    console.log(chalk.gray("Supported platforms:"));
    console.log(chalk.gray("  • OpenAI (Plus/Team/Pro subscriptions)"));
    console.log(chalk.gray("  • Zhipu AI (Coding Plan)"));
    console.log(chalk.gray("  • Z.ai (Coding Plan)"));
    console.log(chalk.gray("  • Google Cloud (Antigravity)"));
    console.log(chalk.gray("  • GitHub Copilot"));
    if (!watchMode) {
      process.exit(0);
    }
    return;
  }

  // Display results
  console.log(chalk.bold.white("📊 Summary\n"));
  console.log(chalk.gray("  Active platforms: ") + chalk.green.bold(results.length));
  for (const result of results) {
    // Extract all percentages from content
    const percentMatches = result.content.match(/(\d+)%/g);
    let lowestPercent: number | null = null;

    if (percentMatches) {
      const percents = percentMatches.map(m => parseInt(m.replace('%', '')));
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
      "  " + statusColor(statusIcon) + " " +
      chalk.white(result.icon + " " + result.title.replace(" Account Quota", "")) +
      " " + statusText
    );
  }
  console.log();

  // Display detailed results
  for (const result of results) {
    createSectionBox(result.title, result.icon);
    console.log(formatOutputContent(result.content));
  }

  // Display errors if any
  if (errors.length > 0) {
    console.log(chalk.red.bold("\n\n❌ Errors occurred:"));
    console.log(chalk.gray("─".repeat(78)));
    for (const error of errors) {
      console.log(chalk.red("  • " + error));
    }
  }

  // Footer
  console.log(chalk.gray("\n" + "─".repeat(78)));
  const footerParts = [
    chalk.gray("  Last updated: ") + chalk.white(new Date().toLocaleTimeString())
  ];

  if (watchMode && nextUpdateTime) {
    footerParts.push(
      chalk.gray("  Next update in: ") + chalk.cyan(getTimeUntilNextUpdate())
    );
  }

  if (watchMode) {
    footerParts.push(chalk.gray("  Press Ctrl+C to exit"));
  }

  console.log(footerParts.join(chalk.gray(" • ")));
  console.log();

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
    .parse();

  const options = program.opts();
  const watchMode = options.watch;
  const interval = parseInt(options.interval);

  if (isNaN(interval) || interval < 1) {
    console.error(chalk.red("Error: Interval must be a positive number"));
    process.exit(1);
  }

  // Handle graceful shutdown
  process.on("SIGINT", () => {
    console.log(chalk.yellow("\n\n👋 Shutting down dashboard..."));
    isRunning = false;
    process.exit(0);
  });

  if (!watchMode) {
    // Single run mode
    await fetchAndDisplayQuotas(false);
  } else {
    // Watch mode - continuous polling
    console.log(chalk.cyan(`🔄 Starting watch mode (updating every ${interval} minute${interval !== 1 ? 's' : ''})...\n`));

    // Initial fetch
    await fetchAndDisplayQuotas(true, interval);

    // Set up polling
    const intervalMs = interval * 60 * 1000;

    const poll = async () => {
      if (!isRunning) return;

      nextUpdateTime = new Date(Date.now() + intervalMs);

      // Update countdown every second
      const countdownInterval = setInterval(() => {
        if (!isRunning) {
          clearInterval(countdownInterval);
          return;
        }

        // Move cursor up to update the footer
        process.stdout.write("\x1b[2A"); // Move up 2 lines
        process.stdout.write("\x1b[K"); // Clear line

        const footerParts = [
          chalk.gray("  Last updated: ") + chalk.white(new Date().toLocaleTimeString()),
          chalk.gray("  Next update in: ") + chalk.cyan(getTimeUntilNextUpdate()),
          chalk.gray("  Press Ctrl+C to exit")
        ];
        console.log(footerParts.join(chalk.gray(" • ")));
        console.log();
      }, 1000);

      // Wait for the interval, then fetch again
      await new Promise(resolve => setTimeout(resolve, intervalMs));
      clearInterval(countdownInterval);

      if (isRunning) {
        await fetchAndDisplayQuotas(true, interval);
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

