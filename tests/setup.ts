// SPDX-License-Identifier: Apache-2.0
// Pin the log output format so tests that capture stderr and parse
// JSON aren't sensitive to the runner environment (TTY auto-detect,
// LOG_FORMAT=pretty in a dev container, etc.).
process.env.LOG_FORMAT = "json";
