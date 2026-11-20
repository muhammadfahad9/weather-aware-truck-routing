import { useId, useRef, useState, type KeyboardEvent } from 'react';

import type { GeocodeResult } from '../api/types';
import { usePlaceSearch } from '../hooks/usePlaceSearch';
import type { PlaceValue } from '../state/store';

interface Props {
  label: string;
  kind: 'origin' | 'destination';
  value: PlaceValue;
  onChange: (value: PlaceValue) => void;
  error?: string;
  placeholder?: string;
}

/** Autocomplete following the WAI-ARIA combobox (list autocomplete) pattern. */
export function PlaceInput({ label, kind, value, onChange, error, placeholder }: Props) {
  const id = useId();
  const listId = `${id}-list`;
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(-1);
  const [typing, setTyping] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);
  const { results, status } = usePlaceSearch(value.label, open && typing);

  const choose = (r: GeocodeResult) => {
    onChange({ label: r.label, lat: r.lat, lon: r.lon });
    setOpen(false);
    setTyping(false);
    setActive(-1);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      setOpen(true);
      setActive((i) => Math.min(i + 1, results.length - 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActive((i) => Math.max(i - 1, 0));
    } else if (e.key === 'Enter' && open && results.length > 0) {
      e.preventDefault();
      choose(results[Math.max(active, 0)]!);
    } else if (e.key === 'Escape') {
      setOpen(false);
    }
  };

  const showList = open && typing && value.label.trim().length >= 2;
  const errorId = `${id}-error`;

  return (
    <div className="place-row">
      <span className={`place-dot is-${kind}`} aria-hidden="true" />
      <div className="field combobox">
        <label htmlFor={id} className="sr-only">
          {label}
        </label>
        <input
          ref={inputRef}
          id={id}
          className="input"
          role="combobox"
          aria-expanded={showList}
          aria-controls={listId}
          aria-autocomplete="list"
          aria-activedescendant={showList && active >= 0 ? `${listId}-${active}` : undefined}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? errorId : undefined}
          autoComplete="off"
          spellCheck={false}
          placeholder={placeholder ?? label}
          value={value.label}
          onChange={(e) => {
            onChange({ label: e.target.value, lat: null, lon: null });
            setTyping(true);
            setOpen(true);
            setActive(-1);
          }}
          onFocus={() => setOpen(true)}
          onBlur={() => window.setTimeout(() => setOpen(false), 150)}
          onKeyDown={onKeyDown}
        />
        {showList && (
          <ul className="listbox" id={listId} role="listbox" aria-label={`${label} suggestions`}>
            {status === 'loading' && results.length === 0 && (
              <li className="listbox-status" role="presentation">
                Searching…
              </li>
            )}
            {status === 'error' && (
              <li className="listbox-status" role="presentation">
                Search is unavailable right now.
              </li>
            )}
            {status === 'done' && results.length === 0 && (
              <li className="listbox-status" role="presentation">
                No matching places.
              </li>
            )}
            {results.map((r, i) => (
              <li
                key={`${r.label}-${i}`}
                id={`${listId}-${i}`}
                role="option"
                aria-selected={i === active}
                className="option"
                onMouseDown={(e) => {
                  e.preventDefault();
                  choose(r);
                }}
                onMouseEnter={() => setActive(i)}
              >
                <span className="option-name">{r.name}</span>
                {r.context && <span className="option-context">{r.context}</span>}
              </li>
            ))}
          </ul>
        )}
        {error && (
          <span id={errorId} className="field-error">
            {error}
          </span>
        )}
      </div>
    </div>
  );
}
