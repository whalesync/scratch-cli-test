import { Avatar, Box, Stack, Table, Tooltip } from '@mantine/core';
import { CircleXIcon, TriangleAlertIcon } from 'lucide-react';
import type { ValidationEntry } from '../../../../shared/validation-types';
import { Text12Medium, Text12Regular } from '../../components/base/text';

type Level = ValidationEntry['level'];

export function ValidationTooltip({ violations }: { violations: ValidationEntry[] | undefined }) {
  const level = getWorstLevel(violations);
  if (!violations || !level) {
    return null;
  }
  return (
    <Tooltip
      label={<ValidationTooltipContent violations={violations} />}
      position="top"
      multiline
      offset={10}
      zIndex={10020}
      withArrow={false}
      styles={{
        tooltip: {
          backgroundColor: 'var(--bg-base)',
          border: '1px solid var(--fg-divider)',
          borderRadius: 0,
          boxShadow: 'none',
          padding: 12,
        },
      }}
    >
      <Avatar color={level === 'error' ? 'red' : 'orange'} radius="sm" size="sm">
        {level === 'error' && <CircleXIcon size={18} strokeWidth={2} />}
        {level === 'warning' && <TriangleAlertIcon size={18} strokeWidth={2} />}
      </Avatar>
    </Tooltip>
  );
}

export function ValidationTooltipContent({
  violations,
  fullWidth,
  showFieldColumn,
}: {
  violations: ValidationEntry[];
  fullWidth?: boolean;
  showFieldColumn?: boolean;
}) {
  return (
    <Box
      style={fullWidth ? { width: '100%', maxWidth: 800, padding: 2 } : { minWidth: 420, maxWidth: 560, padding: 2 }}
    >
      <Table
        fz="xs"
        withRowBorders={false}
        horizontalSpacing={10}
        verticalSpacing={7}
        styles={{
          table: { tableLayout: 'fixed' },
          th: {
            borderBottom: '1px solid rgba(15, 23, 42, 0.10)',
            color: 'rgba(15, 23, 42, 0.48)',
            fontSize: 10,
            fontWeight: 700,
            letterSpacing: '0.08em',
            paddingBottom: 8,
            textTransform: 'uppercase',
          },
          td: {
            borderBottom: '1px solid rgba(15, 23, 42, 0.06)',
            color: 'rgba(15, 23, 42, 0.88)',
            lineHeight: 1.35,
          },
        }}
      >
        <Table.Thead>
          <Table.Tr>
            <Table.Th style={{ width: 82 }}>Level</Table.Th>
            {showFieldColumn && <Table.Th style={{ width: 150 }}>Field</Table.Th>}
            <Table.Th>Message</Table.Th>
            <Table.Th style={{ width: 150 }}>Validator</Table.Th>
          </Table.Tr>
        </Table.Thead>
        <Table.Tbody>
          {violations.map((violation, index) => (
            <Table.Tr key={`${violation.level}-${violation.validatorKind}-${index}`}>
              <Table.Td>
                <Box
                  component="span"
                  style={{
                    display: 'inline-flex',
                    alignItems: 'center',
                    borderRadius: 999,
                    background: validationLevelSurface(violation.level),
                    color: validationLevelColor(violation.level),
                    fontSize: 10,
                    fontWeight: 800,
                    letterSpacing: '0.04em',
                    padding: '3px 7px',
                    textTransform: 'uppercase',
                  }}
                >
                  {violation.level}
                </Box>
              </Table.Td>
              {showFieldColumn && (
                <Table.Td>
                  <Text12Medium c="var(--fg-primary)" style={{ wordBreak: 'break-all' }}>
                    {violation.fieldPath ?? '-'}
                  </Text12Medium>
                </Table.Td>
              )}
              <Table.Td style={{ wordBreak: 'break-word' }}>
                <Stack gap={3}>
                  <Text12Medium c="rgba(15, 23, 42, 0.92)">{violation.message ?? 'No message'}</Text12Medium>
                  {violation.description && (
                    <Text12Regular c="rgba(15, 23, 42, 0.62)" style={{ lineHeight: 1.35 }}>
                      {violation.description}
                    </Text12Regular>
                  )}
                </Stack>
              </Table.Td>
              <Table.Td
                style={{
                  color: 'rgba(15, 23, 42, 0.58)',
                  fontFamily: 'monospace',
                  fontSize: 11,
                  overflowWrap: 'anywhere',
                }}
              >
                {formatValidatorName(violation.validatorKind)}
              </Table.Td>
            </Table.Tr>
          ))}
        </Table.Tbody>
      </Table>
    </Box>
  );
}

function getWorstLevel(violations: ValidationEntry[] | undefined): Level | null {
  if (!violations || violations.length === 0) {
    return null;
  }
  return violations?.some((v) => v.level === 'error') ? 'error' : 'warning';
}

function validationLevelColor(level: Level): string {
  return level === 'error' ? 'var(--mantine-color-red-6)' : 'var(--mantine-color-orange-6)';
}

function validationLevelSurface(level: Level): string {
  return level === 'error' ? 'var(--mantine-color-red-0)' : 'var(--mantine-color-yellow-0)';
}

function formatValidatorName(validatorKind: string): string {
  return validatorKind.replace(/[_-]+/g, ' ');
}
