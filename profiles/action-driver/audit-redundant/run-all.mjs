#!/usr/bin/env node
import { runAudit } from './runner.mjs'
try { runAudit('all', process.argv.slice(2)) } catch (e) { console.error(e.message); process.exitCode = 2 }
