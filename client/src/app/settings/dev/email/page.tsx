'use client';

import { ButtonPrimarySolid } from '@/app/components/base/buttons';
import MainContent from '@/app/components/layouts/MainContent';
import { devToolsApi } from '@/lib/api/dev-tools';
import { Select, Stack, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { EmailTemplate } from '@spinner/shared-types';
import { MailIcon } from 'lucide-react';
import { useCallback, useState } from 'react';

interface TemplateDefinition {
  label: string;
  templateId: EmailTemplate;
  fields: { key: string; label: string; placeholder: string }[];
}

const TEMPLATES: TemplateDefinition[] = [
  {
    label: 'Workspace Invite',
    templateId: EmailTemplate.WorkspaceInvite,
    fields: [
      { key: 'inviterName', label: 'Inviter Name', placeholder: 'Jane Doe' },
      { key: 'workspaceName', label: 'Workspace Name', placeholder: 'My Workspace' },
      { key: 'loginUrl', label: 'Login URL', placeholder: 'https://app.scratch.dev' },
    ],
  },
  {
    label: 'Invite Accepted',
    templateId: EmailTemplate.InviteAccepted,
    fields: [
      { key: 'acceptedByName', label: 'Accepted By Name', placeholder: 'John Smith' },
      { key: 'workspaceName', label: 'Workspace Name', placeholder: 'My Workspace' },
      { key: 'workspaceUrl', label: 'Workspace URL', placeholder: 'https://app.scratch.dev' },
    ],
  },
  {
    label: 'Waitlist Approved',
    templateId: EmailTemplate.WaitlistApproved,
    fields: [{ key: 'loginUrl', label: 'Login URL', placeholder: 'https://app.scratch.dev' }],
  },
];

export default function EmailTestingDevPage() {
  const [selectedTemplate, setSelectedTemplate] = useState<string | null>(null);
  const [recipientEmail, setRecipientEmail] = useState('');
  const [dynamicData, setDynamicData] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);

  const template = TEMPLATES.find((t) => t.templateId === selectedTemplate);

  const handleTemplateChange = useCallback((value: string | null) => {
    setSelectedTemplate(value);
    setDynamicData({});
  }, []);

  const handleFieldChange = useCallback((key: string, value: string) => {
    setDynamicData((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSend = useCallback(async () => {
    if (!selectedTemplate || !recipientEmail) return;

    setSending(true);
    try {
      const res = await devToolsApi.sendTestEmail(selectedTemplate, recipientEmail, dynamicData);
      if (res.success) {
        notifications.show({ title: 'Email sent', message: `Test email sent to ${recipientEmail}`, color: 'green' });
      } else {
        notifications.show({ title: 'Error', message: 'Failed to send test email', color: 'red' });
      }
    } catch {
      notifications.show({ title: 'Error', message: 'Failed to send test email', color: 'red' });
    } finally {
      setSending(false);
    }
  }, [selectedTemplate, recipientEmail, dynamicData]);

  return (
    <MainContent>
      <MainContent.BasicHeader title="Email Testing" Icon={MailIcon} />
      <MainContent.Body>
        <Stack maw={480}>
          <Select
            label="Template"
            placeholder="Select a template"
            data={TEMPLATES.map((t) => ({ value: t.templateId, label: t.label }))}
            value={selectedTemplate}
            onChange={handleTemplateChange}
          />

          <TextInput
            label="Recipient Email"
            placeholder="test@example.com"
            type="email"
            value={recipientEmail}
            onChange={(e) => setRecipientEmail(e.currentTarget.value)}
          />

          {template?.fields.map((field) => (
            <TextInput
              key={field.key}
              label={field.label}
              placeholder={field.placeholder}
              value={dynamicData[field.key] ?? ''}
              onChange={(e) => handleFieldChange(field.key, e.currentTarget.value)}
            />
          ))}

          <ButtonPrimarySolid
            onClick={handleSend}
            loading={sending}
            disabled={!selectedTemplate || !recipientEmail}
            style={{ alignSelf: 'flex-start' }}
          >
            Send Test Email
          </ButtonPrimarySolid>
        </Stack>
      </MainContent.Body>
    </MainContent>
  );
}
