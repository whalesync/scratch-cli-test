'use client';

import { ButtonPrimarySolid } from '@/app/components/base/buttons';
import MainContent from '@/app/components/layouts/MainContent';
import { scratchApiClient } from '@/lib/api/scratch-api-client';
import { Select, Stack, TextInput } from '@mantine/core';
import { notifications } from '@mantine/notifications';
import { EMAIL_TEMPLATE_PAYLOADS, EmailTemplate } from '@spinner/shared-types';
import { MailIcon } from 'lucide-react';
import { useCallback, useState } from 'react';

export default function EmailTestingDevPage() {
  const [selectedTemplate, setSelectedTemplate] = useState<EmailTemplate | null>(null);
  const [recipientEmail, setRecipientEmail] = useState('');
  const [templateData, setTemplateData] = useState<Record<string, string>>({});
  const [sending, setSending] = useState(false);

  const fields = selectedTemplate ? EMAIL_TEMPLATE_PAYLOADS[selectedTemplate] : [];

  // The server requires every field the template uses, so start each one blank rather than missing.
  const handleTemplateChange = useCallback((value: EmailTemplate | null) => {
    setSelectedTemplate(value);
    setTemplateData(value ? Object.fromEntries(EMAIL_TEMPLATE_PAYLOADS[value].map((field) => [field, ''])) : {});
  }, []);

  const handleFieldChange = useCallback((key: string, value: string) => {
    setTemplateData((prev) => ({ ...prev, [key]: value }));
  }, []);

  const handleSend = useCallback(async () => {
    if (!selectedTemplate || !recipientEmail) return;

    setSending(true);
    try {
      const res = await scratchApiClient.devTools.sendTestEmail(selectedTemplate, recipientEmail, templateData);
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
  }, [selectedTemplate, recipientEmail, templateData]);

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
              value={templateData[field] ?? ''}
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
