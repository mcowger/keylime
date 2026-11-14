#!/usr/bin/env bun
"use strict";

const { runCli } = require("./linux-tray.js");

if (require.main === module) {
  runCli()
    .then((result) => {
      process.exitCode = result.exitCode;
    })
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    });
}

module.exports = { runCli };
