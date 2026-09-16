#!/usr/bin/env node
import { run } from './src/cli.js'

run().then(
  (code) => process.exit(code),
  (err) => {
    console.error(err)
    process.exit(1)
  }
)
