-- Keep the loser of a two-device conflict.
--
-- The upsert in api/src/mappers.ts refuses a write that is older than what is
-- stored, and the sync layer's mergeOverlayInto does the same client-side.
-- That is the right policy — but it means one of a counselor's two answers is
-- discarded, and a clinician who typed a careful "because" on their laptop and
-- then re-answered on a tablet should not have the first one vanish without
-- trace.
--
-- Nothing reads this back into the merge path. It exists so the owner can see
-- that an overwrite happened and go and ask.

create table review_history (
  id          bigserial primary key,
  round_id    uuid not null,
  person_id   uuid not null,
  scenario_id text not null,
  -- The ScenarioReview exactly as it was, so it can be read or re-imported
  -- by hand without reconstructing it from columns.
  snapshot    jsonb not null,
  replaced_at timestamptz not null default now(),
  reason      text not null check (reason in ('overwrite', 'delete', 'import', 'rejected-stale'))
);
create index on review_history (round_id, scenario_id);
create index on review_history (round_id, person_id, replaced_at desc);

-- Capture the previous row before an update replaces it, and before a delete
-- removes it. A trigger rather than application code because every write path
-- — batch sync, single PUT, the .review.json import — must be covered, and one
-- of them will eventually be added without remembering to log.
create or replace function record_review_history() returns trigger as $$
begin
  if (tg_op = 'UPDATE') then
    -- Only when something a reviewer typed actually changed. Touching
    -- updated_at on an idempotent replay is not history.
    if old.label_verdict is distinct from new.label_verdict
       or old.rationale_verdict is distinct from new.rationale_verdict
       or old.realism_verdict is distinct from new.realism_verdict
       or old.hard_case is distinct from new.hard_case
       or old.comment is distinct from new.comment
       or old.proposed_text_edits is distinct from new.proposed_text_edits then
      insert into review_history (round_id, person_id, scenario_id, snapshot, reason)
      values (old.round_id, old.person_id, old.scenario_id,
              to_jsonb(old) - 'id', 'overwrite');
    end if;
    return new;
  end if;

  insert into review_history (round_id, person_id, scenario_id, snapshot, reason)
  values (old.round_id, old.person_id, old.scenario_id, to_jsonb(old) - 'id', 'delete');
  return old;
end;
$$ language plpgsql;

create trigger reviews_history
  before update or delete on reviews
  for each row execute function record_review_history();
