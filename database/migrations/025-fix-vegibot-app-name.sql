-- Migration 025: correct the display name for the vegetable store.
-- The seed in 023 used the internal system name 'VegiBot'; the PA router
-- shows app_name to consumers in every quote and confirmation message, so
-- it must be the store's actual business name.

update pa.app_registry
   set app_name   = 'Kavya Vegetables',
       updated_at = now()
 where app_id = 'vegibot';
