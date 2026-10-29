-- The owner is never a participant — enforced by the database, not by memory.
--
-- 0003 removed the owner's participation and relied on every enrolment path
-- to leave it that way. They did not: the roster offered "Add to this batch"
-- on the owner's own row, and createPerson, setParticipants and the overlay
-- import all enrolled whoever they were handed. The owner's row came back, and
-- with it the foreign key that 0003 called the structural guarantee stopped
-- guaranteeing anything.
--
-- Same reasoning as the history trigger in 0002: every write path must be
-- covered, and one will eventually be added without remembering the rule.

-- Clean up first, archiving rather than dropping, exactly as 0003 did.
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

-- Enrolling an owner.
create or replace function refuse_owner_participation() returns trigger as $$
begin
  if exists (select 1 from people where id = new.person_id and role = 'owner') then
    raise exception 'the owner administers and does not review; they cannot join a batch'
      using errcode = 'check_violation', constraint = 'round_participants_not_owner';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger round_participants_not_owner
  before insert or update of person_id on round_participants
  for each row execute function refuse_owner_participation();

-- Promoting someone who is already enrolled. Without this, the seed's
-- "promote to owner" path would be a way round the trigger above.
create or replace function refuse_enrolled_owner() returns trigger as $$
begin
  if new.role = 'owner' and exists (select 1 from round_participants where person_id = new.id) then
    raise exception 'this person is enrolled in a batch; the owner cannot be a participant'
      using errcode = 'check_violation', constraint = 'round_participants_not_owner';
  end if;
  return new;
end;
$$ language plpgsql;

create trigger people_owner_not_enrolled
  before update of role on people
  for each row execute function refuse_enrolled_owner();
