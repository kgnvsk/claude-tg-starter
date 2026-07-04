#!/usr/bin/env python3
"""
One-time script to create telethon session.
Run ONCE interactively on the target machine — Telegram will SMS you a code.
After that, the session file (.session) persists and auto_publisher.py uses it.

Usage:
    export TELEGRAM_API_ID=...
    export TELEGRAM_API_HASH=...
    python3 create_session.py

The session will be saved to: ./tg_listener_session.session
Copy it to the same path you use in auto_publisher.py (SESSION_NAME constant).
"""
import os
import asyncio
from telethon import TelegramClient

API_ID = int(os.environ['TELEGRAM_API_ID'])
API_HASH = os.environ['TELEGRAM_API_HASH']
SESSION_NAME = os.environ.get('SESSION_PATH', './tg_listener_session')

async def main():
    print(f"Creating session at: {SESSION_NAME}.session")
    print("Telegram will ask for your phone number and login code (SMS / app)")
    client = TelegramClient(SESSION_NAME, API_ID, API_HASH)
    await client.start()  # prompts interactively
    me = await client.get_me()
    print(f"✅ Logged in as: {me.first_name} (@{me.username}) — ID {me.id}")
    await client.disconnect()

if __name__ == '__main__':
    asyncio.run(main())
