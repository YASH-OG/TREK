import React from 'react';
import { render, type RenderOptions } from '@testing-library/react';
import { MemoryRouter, type MemoryRouterProps } from 'react-router-dom';
import { TranslationProvider } from '../../src/i18n/TranslationContext';
import { ROUTER_FUTURE } from '../../src/routerFuture';

interface RenderWithProvidersOptions extends Omit<RenderOptions, 'wrapper'> {
  initialEntries?: MemoryRouterProps['initialEntries'];
}

function renderWithProviders(
  ui: React.ReactElement,
  { initialEntries = ['/'], ...options }: RenderWithProvidersOptions = {},
) {
  function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter initialEntries={initialEntries} future={ROUTER_FUTURE}>
        <TranslationProvider>{children}</TranslationProvider>
      </MemoryRouter>
    );
  }

  return render(ui, { wrapper: Wrapper, ...options });
}

export * from '@testing-library/react';
export { renderWithProviders as render };
