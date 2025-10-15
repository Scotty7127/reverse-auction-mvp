# System Architecture Documentation - Reverse Auction MVP

## Overview

This document provides a comprehensive overview of the system architecture for the Reverse Auction MVP. It details the backend and frontend technologies, authentication mechanisms, API routes, database schema, and the data relationships that support the application's core functionality.

## Backend

- **Framework:** Node.js with Express.js
- **Database:** PostgreSQL
- **API:** RESTful endpoints managing auctions, bids, and user accounts
- **Business Logic:** Manages auction lifecycle, bid validations, user management, and enforces reverse auction rules
- **Authentication:** JSON Web Token (JWT) based authentication securing API endpoints

### API Routes

- **User Routes:**
  - `POST /api/users/register` — Register a new user
  - `POST /api/users/login` — Authenticate user and return JWT token
  - `GET /api/users/me` — Retrieve authenticated user's profile

- **Auction Routes:**
  - `POST /api/auctions` — Create a new auction (authenticated)
  - `GET /api/auctions` — List all active auctions
  - `GET /api/auctions/:id` — Retrieve details of a specific auction
  - `PUT /api/auctions/:id` — Update auction details (auction creator only)
  - `DELETE /api/auctions/:id` — Delete an auction (auction creator only)

- **Bid Routes:**
  - `POST /api/auctions/:auctionId/bids` — Place a bid on an auction (authenticated)
  - `GET /api/auctions/:auctionId/bids` — List all bids for a specific auction

## Frontend

- **Framework:** Vue.js
- **State Management:** Vuex for centralized state management
- **UI Components:** Auction listings, bid submission forms, user registration/login forms, user dashboard
- **Communication:** Interacts with backend RESTful API endpoints via Axios for data fetching and submission

### Frontend Pages

- **Home Page:** Displays a list of active auctions with filtering and search capabilities
- **Auction Detail Page:** Shows auction details, current lowest bid, and bid submission form
- **User Registration/Login:** Forms for new user signup and existing user login
- **User Dashboard:** Displays user's created auctions and bids placed

## Authentication

- **Method:** JSON Web Tokens (JWT)
- **Registration:** Users register with a username, email, and password; passwords are securely hashed using bcrypt before storage
- **Login:** Users authenticate with email and password, receiving a signed JWT token upon successful login
- **Token Usage:** JWT tokens are included in the Authorization header (`Bearer <token>`) for all protected API requests
- **Security:** Tokens have expiration times; password reset and account verification mechanisms are implemented

## Data Relationships

The system uses a relational database schema in PostgreSQL to model users, auctions, and bids with clear foreign key relationships.

### Database Tables

- **users**
  - `id` (UUID, primary key)
  - `username` (VARCHAR, unique, not null)
  - `email` (VARCHAR, unique, not null)
  - `password_hash` (VARCHAR, not null)
  - `created_at` (TIMESTAMP, default current timestamp)
  - `updated_at` (TIMESTAMP, default current timestamp)

- **auctions**
  - `id` (UUID, primary key)
  - `creator_id` (UUID, foreign key references users(id), not null)
  - `item_description` (TEXT, not null)
  - `start_price` (NUMERIC, not null)
  - `end_time` (TIMESTAMP, not null)
  - `created_at` (TIMESTAMP, default current timestamp)
  - `updated_at` (TIMESTAMP, default current timestamp)

- **bids**
  - `id` (UUID, primary key)
  - `auction_id` (UUID, foreign key references auctions(id), not null)
  - `bidder_id` (UUID, foreign key references users(id), not null)
  - `bid_amount` (NUMERIC, not null)
  - `created_at` (TIMESTAMP, default current timestamp)

### Relationships

- A **User** can create many **Auctions** (`users.id` → `auctions.creator_id`)
- A **User** can place many **Bids** (`users.id` → `bids.bidder_id`)
- An **Auction** has many **Bids** (`auctions.id` → `bids.auction_id`)
- Each **Bid** is associated with one **Auction** and one **User**

## Summary

The Reverse Auction MVP is built on a robust Node.js and PostgreSQL backend with a Vue.js frontend, providing a secure, scalable platform for reverse auctions. The system enforces reverse auction rules where users compete to place the lowest bids on items within a specified timeframe. JWT-based authentication secures user sessions, while the relational database schema ensures data integrity and efficient querying. The clear separation of concerns between frontend and backend facilitates maintainability and extensibility.
