#!/usr/bin/env node
import {executeCommand} from './native.mjs'
const r=executeCommand(['pnpm','exec','eslint','apps','packages','plugins'],process.argv[2]||process.cwd())
process.stdout.write(r.stdout);process.stderr.write(r.stderr||r.error||'');process.exitCode=r.code??2
