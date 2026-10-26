# One file is blocked after an uncertain Telegram upload

A timeout or cancellation after submission does not prove that Telegram rejected the file. Novsky Agent keeps that file's SHA-256 fenced for the exact chat and topic. Automatic retries could send a duplicate. Successful delivery is recorded only from a real provider acknowledgement.

If you have checked the conversation and still need an explicit retry, a server operator can release **one exact uncertain attempt**. This is a root operator command in the trusted kit source. It is not installed in the agent's `bin`, exposed as a tool or added to sudoers. It drops to the selected Claude instance's UID before opening its message database. It does not send files, edit delivery receipts, change permissions or claim that the earlier upload failed.

First inspect the exact chat/topic and file hash. Use `none` when there is no topic; use `--chat-id=-100…` for a group. Keep the output in the private operator record.

```sh
sudo python3 -I "$KIT/assets/lib/operator-release-file-upload.py" inspect \
  --user "$AGENT_USER" --chat-id="$CHAT_ID" --thread-id "$TOPIC_OR_NONE" \
  --sha256 "$FILE_SHA256"
```

Copy the returned `attempt_id`, `delivery_id`, `created_at` and `updated_at` exactly. Release requires `state=sending` with no `message_id`; a completed, changed, different or already-released attempt is refused. If the provider request could still be running, wait for it to finish or stop that selected runtime through its normal maintenance procedure before deciding to release. A late provider acceptance remains possible; the operator must explicitly accept that risk.

```sh
sudo python3 -I "$KIT/assets/lib/operator-release-file-upload.py" release \
  --user "$AGENT_USER" --chat-id="$CHAT_ID" --thread-id "$TOPIC_OR_NONE" \
  --sha256 "$FILE_SHA256" --attempt-id "$ATTEMPT_ID" \
  --delivery-id "$DELIVERY_ID" --created-at "$CREATED_AT" --updated-at "$UPDATED_AT" \
  --acknowledge-possible-duplicate --reason 'Owner requested an explicit retry after checking the conversation'
```

The command atomically archives every original attempt field plus the operator's reason and release time in `outbound_file_release_audit`, then removes only the matching active fence. The original audit entry is never updated by this command. A failure rolls back both operations. Existing receiver acknowledgements are tied to their attempt ID, so a late acknowledgement of the released attempt cannot unlock a newer attempt.

If the command was interrupted or its outcome is unclear, **inspect first**, adding `--attempt-id "$ATTEMPT_ID"`. The response shows the current fence separately from the saved release for that exact old attempt. Do not repeat a release against a different or newer attempt to make an error disappear. A refused result or absent fence without its audit is not proof of delivery or of a successful release.

After a confirmed release, the owner may issue a **new explicit request** to send the file. Tell the owner that the earlier upload may still arrive and a duplicate is possible. This operator action does not reopen the original request's final-delivery ledger, and it never resends automatically. All normal access checks still apply.
