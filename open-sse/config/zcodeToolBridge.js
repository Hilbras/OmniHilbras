// ZCode Start Plan client-tool bridge constants.
//
// The upstream gateway validates the stock ZCode request body (system prompt +
// 34-tool catalog), so client tools cannot be sent as real Anthropic `tools`.
// Instead the client schemas are serialized into the conversation as a text
// contract, the model answers with a JSON envelope, and the bridge converts
// that envelope back into Anthropic `tool_use` blocks.
//
// Every literal the bridge emits lives here — the executor and the bridge
// module stay free of hardcoded markers.
export const TOOL_BRIDGE = {
  // Contract envelope markers, wrapped around the serialized tool schemas.
  contractOpen: "[AVAILABLE TOOLS]",
  contractClose: "[END AVAILABLE TOOLS]",

  // Instructions handed to the model before the tool records.
  instructionLines: [
    "You may request tool calls. If a tool is needed, respond with ONLY JSON in this exact shape:",
    '{"tool_calls":[{"name":"tool_name","input":{}}]}',
    "If the task is complete, respond with ONLY JSON in this exact shape:",
    '{"final":"your final answer"}',
    "Do not use markdown. Do not include prose outside JSON.",
    "Tool input must match the tool input_schema as closely as possible.",
  ],

  // Closing instruction — the model sees it last, right before it answers.
  responseInstruction: "Return exactly one JSON object now. Use tool_calls if more tool actions are needed; use final if done.",

  // Label used in front of each serialized tool record.
  toolRecordLabel: "Tool",

  // Markers used when replaying a tool_use / tool_result turn as plain text.
  previousToolUseMarker: "[PREVIOUS TOOL USE]",
  toolResultMarker: "[TOOL RESULT]",

  // Identifier prefixes for synthesized Anthropic blocks.
  toolUseIdPrefix: "toolu_",
  messageIdPrefix: "msg_",
};
