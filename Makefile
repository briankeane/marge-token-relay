.PHONY: install lint-server test-server build-server prettier-all launch terminate

install:
	cd server && npm ci

lint-server:
	cd server && npm run lint

test-server:
	cd server && npm test

build-server:
	cd server && npm run build

prettier-all:
	npx prettier --write .

launch:
	@echo "requires Phase 2 docker-compose (see Task 7)"

terminate:
	@echo "requires Phase 2 docker-compose (see Task 7)"
