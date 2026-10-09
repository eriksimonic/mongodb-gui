// @vitest-environment jsdom
import '@testing-library/jest-dom/vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { App } from './App';

afterEach(cleanup);

describe('App', () => {
  it('renders the Mongo GUI heading', () => {
    render(<App />);
    expect(screen.getByRole('heading', { name: 'Mongo GUI' })).toBeInTheDocument();
  });
});
