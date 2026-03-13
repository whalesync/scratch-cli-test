import { Flex } from '@mantine/core';
import { PropsWithChildren, useEffect } from 'react';

interface AuthLayoutProps {
  title: string;
}

export const AuthLayout = ({ children, title }: PropsWithChildren<AuthLayoutProps>) => {
  useEffect(() => {
    document.title = title;
  }, [title]);

  return (
    <Flex w="100%" h="100vh" align="center" justify="center" style={{ backgroundColor: 'var(--bg-base)' }}>
      {children}
    </Flex>
  );
};
