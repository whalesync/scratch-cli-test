'use client';

import { ButtonPrimarySolid } from '@/app/components/base/buttons';
import MainContent from '@/app/components/layouts/MainContent';
import { devToolsApi } from '@/lib/api/dev-tools';
import { Select, Stack, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { EMAIL_TEMPLATE_PAYLOADS, EmailTemplate } from '@spinner/shared-types';
import { MailIcon } from 'lucide-react';
import { useCallback, useState } from 'react';

export default function EmailTestingDevPage() {
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);
  const [recipientEmail, setRecipientEmail] = useState('');
  const [dynamicData, setDynamicData] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);

  const fields = selectedTemplate ? EMAIL_TEMPLATE_PAYLOADS[selectedTemplate] : [];

  const handleTemplateChange = useCallback((value: EmailTemplate | null) => {
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
            data={Object.entries(EmailTemplate).map(([name, id]) => ({ value: id, label: name }))}
            value={selectedTemplate}
            onChange={(v) => handleTemplateChange(v as EmailTemplate)}
          />

          <TextInput
            label="Recipient Email"
            placeholder="test@example.com"
            type="email"
            value={recipientEmail}
            onChange={(e) => setRecipientEmail(e.currentTarget.value)}
          />

          {fields.map((field) => (
            <TextInput
              key={field}
              label={field}
              value={dynamicData[field] ?? ''}
              onChange={(e) => handleFieldChange(field, e.currentTarget.value)}
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
