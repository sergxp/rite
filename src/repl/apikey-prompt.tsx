import React, { useState } from "react";
import { Box, Text } from "ink";
import TextInput from "ink-text-input";

interface ApiKeyPromptProps {
  currentKey?: string;
  onSave: (key: string) => void;
  onCancel: () => void;
}

export function ApiKeyPrompt({ currentKey, onSave, onCancel }: ApiKeyPromptProps) {
  const placeholder = currentKey ? `${currentKey.slice(0, 8)}…` : "sk-ant-…";
  const [value, setValue] = useState("");

  function handleSubmit(val: string) {
    const trimmed = val.trim();
    if (!trimmed) {
      onCancel();
      return;
    }
    onSave(trimmed);
  }

  return (
    <Box flexDirection="column" padding={1}>
      <Box marginBottom={1}>
        <Text bold color="cyanBright">Set Anthropic API Key</Text>
      </Box>
      {currentKey && (
        <Box marginBottom={1}>
          <Text dimColor>Current: </Text>
          <Text color="yellow">{placeholder}</Text>
        </Box>
      )}
      <Box
        borderStyle="round"
        borderColor="cyanBright"
        paddingX={1}
        marginBottom={1}
      >
        <Text color="cyanBright">&gt; </Text>
        <TextInput
          value={value}
          onChange={setValue}
          onSubmit={handleSubmit}
          placeholder={placeholder}
          mask="*"
        />
      </Box>
      <Box>
        <Text dimColor>enter save  esc / empty cancel</Text>
      </Box>
    </Box>
  );
}
