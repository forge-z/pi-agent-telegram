import type { Store } from "./store.js";

export function installTopicReceiptInvalidation(store: Store) {
  // Revocation while the API is in flight stays terminal even after a later regrant.
  store.db.exec(`
      DROP TRIGGER IF EXISTS telegram_topic_create_revoke;
      CREATE TRIGGER telegram_topic_create_revoke AFTER DELETE ON telegram_grants BEGIN
        UPDATE meta SET value=json_set(value,'$.state','cancelled')
        WHERE (key GLOB 'telegram:topic-create:*' OR key GLOB 'telegram:native-topic-create:*') AND json_valid(value)
        AND json_extract(value,'$.route.chat')=OLD.chat AND json_extract(value,'$.route.user')=OLD.user
        AND ((json_extract(value,'$.state') IN ('pending','uncertain') AND json_extract(value,'$.authorityId')=OLD.conversationId)
          OR substr(key,length('telegram:topic-create:')+1)=OLD.conversationId OR json_extract(value,'$.conversationId')=OLD.conversationId);
      END;
      DROP TRIGGER IF EXISTS telegram_topic_create_grant_update;
      CREATE TRIGGER telegram_topic_create_grant_update AFTER UPDATE ON telegram_grants
      WHEN OLD.chat IS NOT NEW.chat OR OLD.user IS NOT NEW.user OR OLD.conversationId IS NOT NEW.conversationId BEGIN
        UPDATE meta SET value=json_set(value,'$.state','cancelled')
        WHERE (key GLOB 'telegram:topic-create:*' OR key GLOB 'telegram:native-topic-create:*') AND json_valid(value)
        AND json_extract(value,'$.route.chat')=OLD.chat AND json_extract(value,'$.route.user')=OLD.user
        AND ((json_extract(value,'$.state') IN ('pending','uncertain') AND json_extract(value,'$.authorityId')=OLD.conversationId)
          OR substr(key,length('telegram:topic-create:')+1)=OLD.conversationId OR json_extract(value,'$.conversationId')=OLD.conversationId);
      END;
      DROP TRIGGER IF EXISTS telegram_topic_create_config_update;
      CREATE TRIGGER telegram_topic_create_config_update AFTER UPDATE OF value ON meta
      WHEN NEW.key='telegram:connection' AND OLD.value IS NOT NEW.value BEGIN
        UPDATE meta SET value=json_set(value,'$.state','cancelled')
        WHERE (key GLOB 'telegram:topic-create:*' OR key GLOB 'telegram:native-topic-create:*') AND json_valid(value) AND json_extract(value,'$.state') IN ('pending','uncertain')
        AND CASE WHEN json_valid(NEW.value) THEN json_extract(NEW.value,'$.enabled') IS NOT 1
          OR json_extract(NEW.value,'$.bot.id') IS NOT json_extract(value,'$.route.botId')
          OR NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(NEW.value,'$.allowedChats'),json_array(json_extract(NEW.value,'$.chatId')))) WHERE CAST(json_each.value AS TEXT)=json_extract(meta.value,'$.route.chat'))
          OR NOT EXISTS (SELECT 1 FROM json_each(COALESCE(json_extract(NEW.value,'$.allowedUsers'),json_array(json_extract(NEW.value,'$.userId')))) WHERE CAST(json_each.value AS TEXT)=json_extract(meta.value,'$.route.user')) ELSE 1 END;
      END;
      DROP TRIGGER IF EXISTS telegram_topic_create_config_delete;
      CREATE TRIGGER telegram_topic_create_config_delete AFTER DELETE ON meta
      WHEN OLD.key='telegram:connection' BEGIN
        UPDATE meta SET value=json_set(value,'$.state','cancelled')
        WHERE (key GLOB 'telegram:topic-create:*' OR key GLOB 'telegram:native-topic-create:*') AND json_valid(value) AND json_extract(value,'$.state') IN ('pending','uncertain');
      END;
      DROP TRIGGER IF EXISTS telegram_topic_create_credential_update;
      CREATE TRIGGER telegram_topic_create_credential_update AFTER UPDATE OF value ON credentials
      WHEN OLD.provider='telegram:bot' AND OLD.value IS NOT NEW.value BEGIN
        UPDATE meta SET value=json_set(value,'$.state','cancelled')
        WHERE (key GLOB 'telegram:topic-create:*' OR key GLOB 'telegram:native-topic-create:*') AND json_valid(value) AND json_extract(value,'$.state') IN ('pending','uncertain');
      END;
      DROP TRIGGER IF EXISTS telegram_topic_create_credential_delete;
      CREATE TRIGGER telegram_topic_create_credential_delete AFTER DELETE ON credentials
      WHEN OLD.provider='telegram:bot' BEGIN
        UPDATE meta SET value=json_set(value,'$.state','cancelled')
        WHERE (key GLOB 'telegram:topic-create:*' OR key GLOB 'telegram:native-topic-create:*') AND json_valid(value) AND json_extract(value,'$.state') IN ('pending','uncertain');
      END;
    `);
}
