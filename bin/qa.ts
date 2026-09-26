#!/usr/bin/env node
// app-qa CLI entry point.
import { main } from '../src/cli/index.ts';

process.exitCode = await main(process.argv.slice(2));
