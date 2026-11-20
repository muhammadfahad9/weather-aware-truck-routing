# Convenience targets. Paths contain no spaces inside the repo, so plain make works.
PY := backend/.venv/bin/python

.PHONY: setup dev-api dev-web test lint e2e docker fixtures

setup:            ## Install backend (venv) and frontend dependencies
	python3 -m venv backend/.venv && backend/.venv/bin/pip install -r backend/requirements-dev.txt
	cd frontend && npm ci

dev-api:          ## Django API on :8010 (real providers)
	cd backend && DJANGO_DEBUG=1 ../$(PY) manage.py runserver 127.0.0.1:8010

dev-web:          ## Vite dev server on :5173, proxying /api to :8010
	cd frontend && VITE_BACKEND_URL=http://127.0.0.1:8010 npm run dev

test:             ## Unit + integration tests (backend and frontend)
	cd backend && .venv/bin/pytest --cov
	cd frontend && npm run test:coverage

lint:             ## Linters, formatters and type checkers
	cd backend && .venv/bin/ruff check . && .venv/bin/ruff format --check . && .venv/bin/mypy
	cd frontend && npm run lint && npm run format:check && npm run typecheck

e2e:              ## Playwright end-to-end suite (builds the SPA, runs Django offline)
	cd frontend && npm run e2e

fixtures:         ## Regenerate frontend contract fixtures from the backend pipeline
	cd backend && DJANGO_DEBUG=1 .venv/bin/python manage.py export_fixtures ../frontend/src/test/fixtures

docker:           ## Build and run the production image on :8080
	docker compose up --build
