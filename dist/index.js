"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.isSens = exports.fmt = exports.moduleCallsPlan = exports.summarize = void 0;
// Public surface of the TSM drift contract. The single source of truth for the
// count/summary/attrs semantics shared by every drift consumer:
//   - the GitHub Action  (terraform-drift-report)
//   - the Azure DevOps task (TerraformDriftReport, initiative 6)
//   - mirrored by the backend's internal/services/driftingest (Go) and by the jq
//     in its dispatched CI templates, via the vendored golden fixtures. This
//     package (src/summarize.ts + __tests__/) is the authority they are diffed
//     against; see SECURITY.md.
var summarize_1 = require("./summarize");
Object.defineProperty(exports, "summarize", { enumerable: true, get: function () { return summarize_1.summarize; } });
Object.defineProperty(exports, "moduleCallsPlan", { enumerable: true, get: function () { return summarize_1.moduleCallsPlan; } });
Object.defineProperty(exports, "fmt", { enumerable: true, get: function () { return summarize_1.fmt; } });
Object.defineProperty(exports, "isSens", { enumerable: true, get: function () { return summarize_1.isSens; } });
