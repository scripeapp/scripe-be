drop function if exists app.staff_calendar_users(uuid, uuid[]);
drop function if exists app.forget_booking_calendar_event(uuid);
drop function if exists app.record_booking_calendar_event(uuid, uuid, uuid, text, text);
drop function if exists app.booking_calendar_targets(uuid);
drop table if exists app.booking_calendar_events;
drop table if exists app.calendar_connections;
