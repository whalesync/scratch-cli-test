'use client';

import { ButtonSecondaryInline } from '@/app/components/base/buttons';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { FileButton, Group, Stack, Textarea } from '@mantine/core';
import { ConnectorSettingDefinition } from '@spinner/shared-types';
import { UploadIcon } from 'lucide-react';
import { useRef, useState } from 'react';

/**
 * Certificate exports (`.pem`, `.crt`, `.cer`) and private keys (`.key`). All are PEM text; the server rejects
 * anything that isn't, with a message naming the field.
 */
const PEM_FILE_PICKER_ACCEPT = '.pem,.crt,.cer,.key,application/x-pem-file,application/x-x509-ca-cert,text/plain';

/**
 * A `format: 'pem'` credential field (a certificate, a CA bundle, or a private key): a monospace textarea that keeps
 * the pasted line breaks, plus "Load from file" for providers that hand the PEM out as a download. The text stays
 * visible while it's entered — the connection form never shows a saved value again. Rendered by both the
 * create-connection and edit-connection modals.
 */
export function PemCredentialField({
  field,
  value,
  onChange,
}: {
  field: ConnectorSettingDefinition;
  value: string;
  onChange: (value: string) => void;
}) {
  const [fileReadErrorMessage, setFileReadErrorMessage] = useState<string | null>(null);
  // Clears the hidden file input after each pick, so choosing the same file again (after editing the text) reloads it.
  const resetFilePickerSelection = useRef<() => void>(null);

  const loadPemTextFromPickedFile = (pickedFile: File | null) => {
    if (!pickedFile) return;
    pickedFile
      .text()
      .then((pemTextFromFile) => {
        setFileReadErrorMessage(null);
        onChange(pemTextFromFile);
      })
      .catch(() => setFileReadErrorMessage(`Couldn't read ${pickedFile.name}.`))
      .finally(() => resetFilePickerSelection.current?.());
  };

  return (
    <Stack gap={4}>
      <Textarea
        label={field.label}
        description={field.description}
        placeholder={field.placeholder}
        autosize
        minRows={4}
        maxRows={10}
        spellCheck={false}
        autoComplete="off"
        error={fileReadErrorMessage}
        styles={{ input: { fontFamily: 'var(--mantine-font-family-monospace)', fontSize: 12 } }}
        value={value}
        onChange={(e) => {
          setFileReadErrorMessage(null);
          onChange(e.currentTarget.value);
        }}
      />
      <div>
        <FileButton
          resetRef={resetFilePickerSelection}
          accept={PEM_FILE_PICKER_ACCEPT}
          onChange={loadPemTextFromPickedFile}
        >
          {(fileButtonProps) => (
            <ButtonSecondaryInline {...fileButtonProps}>
              <Group gap={4} align="center" wrap="nowrap">
                <StyledLucideIcon Icon={UploadIcon} size="sm" />
                Load from file
              </Group>
            </ButtonSecondaryInline>
          )}
        </FileButton>
      </div>
    </Stack>
  );
}
