import { ButtonDangerLight } from '@/app/components/base/buttons';
import { Text13Book, Text13Regular } from '@/app/components/base/text';
import { StyledLucideIcon } from '@/app/components/Icons/StyledLucideIcon';
import { useNewWorkbookUIStore } from '@/stores/new-workbook-ui-store';
import { Alert, Code, Stack, UnstyledButton } from '@mantine/core';
import { AlertTriangleIcon } from 'lucide-react';
import { usePathname } from 'next/navigation';
import { useMemo, useState } from 'react';

export const WorkbookErrorAlert = () => {
  const pathname = usePathname();
  const workbookError = useNewWorkbookUIStore((state) => state.workbookError);
  const clearWorkbookError = useNewWorkbookUIStore((state) => state.clearWorkbookError);
  const [showDetails, setShowDetails] = useState(false);

  const isVisible = useMemo(() => {
    if (workbookError === null) {
      return false;
    }

    if (workbookError.scope === undefined) {
      return true;
    }
    return pathname.includes(`/${workbookError.scope}`);
  }, [workbookError, pathname]);

  if (!isVisible || workbookError === null) {
    return null;
  }

  return (
    <Alert
      color="red"
      variant="light"
      p="xs"
      title={workbookError.title}
      withCloseButton={true}
      onClose={() => {
        setShowDetails(false);
        clearWorkbookError();
      }}
      icon={<StyledLucideIcon Icon={AlertTriangleIcon} size={16} />}
    >
      <Stack w="100%" align="flex-start">
        <Text13Regular c="red.6">{workbookError.description}</Text13Regular>

        {workbookError.cause && (
          <>
            <UnstyledButton fz="xs" c="red" td="underline" onClick={() => setShowDetails((v) => !v)}>
              {showDetails ? 'Hide details' : 'More details'}
            </UnstyledButton>
            {showDetails && (
              <Stack>
                <Text13Book>{workbookError.cause.message}</Text13Book>
                <Code block fz="xs" style={{ whiteSpace: 'pre-wrap', maxHeight: 200, overflow: 'auto' }}>
                  {workbookError.cause.stack}
                </Code>
              </Stack>
            )}
          </>
        )}

        {workbookError.action?.onClick && (
          <ButtonDangerLight
            size="compact-xs"
            onClick={() => {
              setShowDetails(false);
              workbookError.action?.onClick();
            }}
          >
            {workbookError.action.label}
          </ButtonDangerLight>
        )}
      </Stack>
    </Alert>
  );
};
