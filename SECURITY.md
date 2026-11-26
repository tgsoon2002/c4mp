# Security policy

## Reporting a vulnerability

Report security problems privately, through GitHub's private vulnerability reporting: open the repository's
**Security** tab and choose **Report a vulnerability**. Please do not open a public issue or pull request for a
security problem.

Include the C4MP version, your operating system, the steps to reproduce, and what an attacker could do. We will
acknowledge your report, keep you informed, and credit you in the fix if you want.

## In scope

- The `c4mp` command line tool (reading repositories, writing under `.c4mp/` and `C4MP/`).
- The local `c4mp serve` server on 127.0.0.1 (for example reaching it from another machine or another website, or
  reading or writing files outside the project).
- The MCP server.

## Supported versions

Only the latest release gets security fixes. Please update before you report.
