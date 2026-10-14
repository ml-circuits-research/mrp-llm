# 89-code-sandbox-containment

Feature: `code_sandbox`. Containment: a program tries require, process, fetch and a constructor escape, and each attempt is blocked inside the sandbox (ReferenceError). The program verifies only because every attempt was blocked; the host process, the filesystem and the network are untouched.

Only the `code-sandbox` strategy expresses it; every reasoning engine declares the feature unsupported.
