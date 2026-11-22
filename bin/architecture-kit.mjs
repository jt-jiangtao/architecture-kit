#!/usr/bin/env node
import { main } from '@architecture-kit/cli'
process.exitCode = await main(process.argv.slice(2))
