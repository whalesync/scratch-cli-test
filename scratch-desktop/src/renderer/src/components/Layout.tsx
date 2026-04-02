import { Box } from '@mantine/core';
import { Outlet } from 'react-router-dom';

export function Layout() {
  return (
    <Box h="100vh" style={{ display: 'flex', flexDirection: 'column' }}>
      <Box style={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column' }}>
        <Outlet />
      </Box>
    </Box>
  );
}
