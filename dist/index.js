"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSens = exports.fmt = exports.moduleCallsPlan = exports.summarize = void 0;
// Public surface of the TSM drift contract. The single source of truth for the
// count/summary/attrs semantics shared by every drift consumer:
//   - the GitHub Action  (terraform-drift-report)
//   - the Azure DevOps task (TerraformDriftReport, initiative 6)
//   - mirrored by the backend's internal/services/driftingest (Go) and by the jq
//     in its dispatched CI templates. This package (src/summarize.ts +
//     __tests__/) is the authority they are diffed against; see SECURITY.md.
//
// That diffing is done by `conformance/vectors.json`: one input plan per vector
// plus the expected output, run by all three implementations from a
// byte-identical copy and compared byte-for-byte. Each side pins the same
// SHA-256 of the corpus file AND the same digest over its own rendered results,
// so a divergence reddens both repositories without either needing to see the
// other's output. Differences that are real and deliberate (the jq summary has
// no `attrs` at all; Go rejects a malformed document at its unmarshal boundary)
// are STATED per vector in the corpus — a difference with no entry there is a
// regression.
//
// An earlier revision of this comment said the mirrors were kept in lockstep
// "via the vendored golden fixtures"; no such shared fixture set existed at the
// time, and the correction that replaced it said nothing detected a divergence.
// Both are now superseded by the corpus. See the "Cross-implementation
// obligation" section of SECURITY.md.
var summarize_1 = require("./summarize");
Object.defineProperty(exports, "summarize", { enumerable: true, get: function () { return summarize_1.summarize; } });
Object.defineProperty(exports, "moduleCallsPlan", { enumerable: true, get: function () { return summarize_1.moduleCallsPlan; } });
Object.defineProperty(exports, "fmt", { enumerable: true, get: function () { return summarize_1.fmt; } });
Object.defineProperty(exports, "isSens", { enumerable: true, get: function () { return summarize_1.isSens; } });
