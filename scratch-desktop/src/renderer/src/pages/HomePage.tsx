import { useUser } from '@clerk/clerk-react';
import { Center, Stack, Text, Title } from '@mantine/core';

export function HomePage() {
  const { user } = useUser();

  return (
    <Center h="100vh">
      <Stack align="center" gap="sm">
        <Title order={1}>Scratch Desktop</Title>
        <Text c="dimmed">Signed in as {user?.primaryEmailAddress?.emailAddress}</Text>
      </Stack>
    </Center>
  );
}
