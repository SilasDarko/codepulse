.PHONY: setup db-up db-down migrate seed dev worker build \
        test test-unit test-integration test-e2e test-coverage \
        benchmark lint typecheck clean

# First-time setup: install deps, start Postgres, wait for it, run migrations.
setup: install db-up migrate
	@echo "Setup complete. Copy .env.example to .env, then run 'make dev' and 'make worker' in separate terminals."

install:
	npm install

db-up:
	docker compose up -d db
	@echo "Waiting for Postgres to be healthy..."
	@until docker compose ps db | grep -q healthy; do sleep 1; done

db-down:
	docker compose down

migrate:
	npm run db:migrate
	npm run db:migrate:test

seed:
	npm run seed

dev:
	npm run dev

worker:
	npm run worker

build:
	npm run build

test:
	npm test

test-unit:
	npm run test:unit

test-integration:
	npm run test:integration

test-e2e:
	npm run test:e2e

test-coverage:
	npm run test:coverage

benchmark:
	npm run benchmark

lint:
	npm run lint
	npm run typecheck

clean:
	rm -rf .next node_modules coverage playwright-report test-results benchmark-results
