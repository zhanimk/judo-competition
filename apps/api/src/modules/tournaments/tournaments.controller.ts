import { CurrentUser } from '../auth/auth.guard.js';
import type { Principal } from '../auth/auth.types.js';
import { Controller, Get, Post, Param, Body, ParseUUIDPipe } from '@nestjs/common';
import { TournamentsService } from './tournaments.service.js';
import { CreateTournamentDto, CreateCategoryDto, CreateEntryDto } from './dto.js';
@Controller('tournaments')
export class TournamentsController {
  constructor(private readonly service: TournamentsService) {}
  @Get() list(@CurrentUser() user: Principal) {
    return this.service.list(user);
  }
  @Get(':id') get(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: Principal) {
    return this.service.get(id, user);
  }
  @Post(':id/publish') publish(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.service.publish(id, user);
  }
  @Post(':id/schedule') schedule(
    @Param('id', ParseUUIDPipe) id: string,
    @CurrentUser() user: Principal,
  ) {
    return this.service.schedule(id, user);
  }
  @Post(':id/start') start(@Param('id', ParseUUIDPipe) id: string, @CurrentUser() user: Principal) {
    return this.service.start(id, user);
  }
  @Post() create(@Body() dto: CreateTournamentDto, @CurrentUser() user: Principal) {
    return this.service.create(dto, user);
  }
  @Post(':id/categories') category(
    @Param('id', ParseUUIDPipe) id: string,
    @Body() dto: CreateCategoryDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.category(id, dto, user);
  }
  @Post(':id/categories/:categoryId/entries') entry(
    @Param('id', ParseUUIDPipe) id: string,
    @Param('categoryId', ParseUUIDPipe) categoryId: string,
    @Body() dto: CreateEntryDto,
    @CurrentUser() user: Principal,
  ) {
    return this.service.entry(id, categoryId, dto, user);
  }
}
