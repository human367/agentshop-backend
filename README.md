# agentdata.shop — Backend API

Testing and evaluation environment for agentic commerce workflows.

## API Base URL
https://api.agentdata.shop

## Endpoints
- GET /api/scenarios — list test scenarios
- GET /api/scenarios/:id — get single scenario
- GET /api/match — find products by constraints
- POST /api/cart/add — add to cart
- POST /api/checkout — checkout
- POST /api/evaluate — evaluate an agent run
- GET /api/runs — get run history

## Quick Start
curl https://api.agentdata.shop/api/scenarios

## Stack
Node.js + Express, deployed on Railway

## Docs
https://docs.agentdata.shop
