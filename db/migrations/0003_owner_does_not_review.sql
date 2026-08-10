-- The owner administers; the counselors judge.
--
-- The owner sees every verdict by design (§6.1) — they resolve disagreement,
-- which cannot be done blind. That makes their own verdicts worthless as data:
-- they would be recorded by someone who had already read everyone else's, and
-- including them would quietly contaminate the inter-rater agreement number
-- that the whole exercise exists to produce.
--
-- So the owner is not a participant in any round. `reviews` and `proposals`
-- both carry a foreign key to `round_participants`, which makes this a
-- structural guarantee rather than a convention: with no participation row,
-- the database itself will refuse an owner's verdict. The API also returns a
-- clear 403 so the failure reads as a rule, not a bug.
--
-- The owner keeps full access without participating: `requireActiveSession`
-- admits them on `role = 'owner'` rather than on enrollment.

-- Widen the reason check first: the archival insert below uses a value the
-- original constraint does not know about.
alter table review_history drop constraint if exists review_history_reason_check;
alter table review_history add constraint review_history_reason_check
  check (reason in ('overwrite', 'delete', 'import', 'rejected-stale', 'owner-excluded'));

-- Any verdicts an owner recorded before this rule existed are archived rather
-- than dropped, so nothing is silently destroyed. (The delete below would fire
-- the history trigger anyway; this row records *why* it went.)
insert into review_history (round_id, person_id, scenario_id, snapshot, reason)
select r.round_id, r.person_id, r.scenario_id, to_jsonb(r) - 'id', 'owner-excluded'
  from reviews r
  join people p on p.id = r.person_id
 where p.role = 'owner';

delete from reviews r
 using people p
 where p.id = r.person_id and p.role = 'owner';

delete from proposals pr
 using people p
 where p.id = pr.author_id and p.role = 'owner';

delete from round_participants rp
 using people p
 where p.id = rp.person_id and p.role = 'owner';
