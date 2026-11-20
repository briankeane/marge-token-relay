import { render, screen } from '@testing-library/react';
import App from './App';
test('renders the marge dashboard heading', () => {
  render(<App />);
  expect(screen.getByRole('heading', { name: /marge/i })).toBeInTheDocument();
});
