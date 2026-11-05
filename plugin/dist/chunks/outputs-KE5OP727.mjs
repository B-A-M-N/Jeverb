import"./chunk-DDLAJ7Z6.mjs";var n=new Set(["UserPromptSubmit","PostToolUse","PostToolUseFailure","PostToolBatch","SubagentStart"]);function t(o){return n.has(o)}function i(o,e){if(e){if(o==="PermissionRequest")return e.enforcement==="deny"?{hookSpecificOutput:{hookEventName:o,decision:{behavior:"deny",message:e.reasons.join(`
`)}}}:void 0;if(o==="PreToolUse")return e.enforcement==="deny"?{hookSpecificOutput:{hookEventName:o,permissionDecision:"deny",permissionDecisionReason:e.reasons.join(`
`)}}:e.enforcement==="ask"?{hookSpecificOutput:{hookEventName:o,permissionDecision:"ask"}}:e.enforcement==="advise"?{hookSpecificOutput:{hookEventName:o,additionalContext:e.reasons.join(`
`)}}:void 0;if((o==="Stop"||o==="SubagentStop")&&e.enforcement==="continue_work")return{decision:"block",reason:e.reasons.join(`
`)};if(o==="Stop"&&e.enforcement==="terminal"&&e.terminalOutcome!==void 0)return{continue:!1,stopReason:`TOTAL_MISSION_${e.terminalOutcome.status}: ${e.reasons.join(`
`)}`};if(t(o)&&e.enforcement==="advise")return{hookSpecificOutput:{hookEventName:o,additionalContext:e.reasons.join(`
`)}}}}export{t as supportsContext,i as toMuseOutput};
